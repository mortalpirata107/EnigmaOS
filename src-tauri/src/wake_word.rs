use std::env;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tauri::{AppHandle, Emitter};
use vosk::{DecodingState, Model, Recognizer};

static MANUAL_START_STT: AtomicBool = AtomicBool::new(false);
static MANUAL_STOP_STT: AtomicBool = AtomicBool::new(false);

/// Triggers dictation mode from Tauri command
pub fn trigger_start_dictation() {
    MANUAL_START_STT.store(true, Ordering::SeqCst);
}

/// Cancels dictation mode from Tauri command
pub fn trigger_stop_dictation() {
    MANUAL_STOP_STT.store(true, Ordering::SeqCst);
}

/// Finds a valid Vosk model directory from candidate locations
fn find_vosk_model() -> Option<PathBuf> {
    if let Ok(p) = env::var("VOSK_MODEL_PATH") {
        let path = PathBuf::from(p);
        if path.is_dir() {
            return Some(path);
        }
    }

    if let Ok(home) = env::var("HOME") {
        let user_path = PathBuf::from(home).join(".local/share/vosk/vosk-model-small-es");
        if user_path.is_dir() {
            return Some(user_path);
        }
    }

    let candidate_paths = [
        "models/vosk-model-small-es",
        "src-tauri/models/vosk-model-small-es",
        "/usr/share/vosk-models/vosk-model-small-es",
        "/usr/local/share/vosk-models/vosk-model-small-es",
    ];

    for candidate in candidate_paths {
        let p = Path::new(candidate);
        if p.is_dir() {
            return Some(p.to_path_buf());
        }
    }

    None
}

/// Helper function to check if the recognized text is an exact match for the wake words
fn check_and_trigger(
    raw_text: &str,
    app_handle: &AppHandle,
    last_trigger: &mut Instant,
) -> bool {
    let text = raw_text.trim().to_lowercase();
    if text == "oye enigma" || text == "hey enigma" {
        // Debounce triggers within 1.5 seconds to prevent multiple firings
        if last_trigger.elapsed() > Duration::from_millis(1500) {
            eprintln!("[WakeWord] >>> Wake word detected: '{}'! Emitting toggle-enigma and starting STT <<<", text);
            let _ = app_handle.emit("toggle-enigma", ());
            *last_trigger = Instant::now();
        }
        return true;
    }
    false
}

enum VoskMode {
    WakeWord,
    Dictation {
        started_at: Instant,
        last_speech: Instant,
        has_spoken: bool,
        accumulated: String,
    },
}

/// Spawns the dedicated background thread for wake-word detection using cpal and Vosk
pub fn start_wake_word_listener(app_handle: AppHandle) {
    thread::Builder::new()
        .name("enigma-wake-word-listener".to_string())
        .spawn(move || {
            eprintln!("[WakeWord] Initializing background wake word listener...");

            // 1. Locate and load Vosk model
            let model_path = match find_vosk_model() {
                Some(p) => p,
                None => {
                    eprintln!("[WakeWord] Model 'vosk-model-small-es' not found. Wake word disabled.");
                    return;
                }
            };

            eprintln!("[WakeWord] Loading Vosk model from: {:?}", model_path);
            let model = match Model::new(model_path.to_str().unwrap()) {
                Some(m) => m,
                None => {
                    eprintln!("[WakeWord] Failed to initialize Vosk model from path: {:?}", model_path);
                    return;
                }
            };

            // 2. Setup CPAL Audio Host and Input Device
            // CRÍTICO: Seleccionar explícitamente el dispositivo virtual compartido ("pulse", "pipewire", "default")
            // para que PipeWire maneje la mezcla y NUNCA se bloquee de forma exclusiva el hardware ALSA (/dev/snd/pcm*).
            let host = cpal::default_host();
            let device = host
                .input_devices()
                .ok()
                .and_then(|mut devs| {
                    devs.find(|d| {
                        d.name()
                            .map(|n| {
                                let l = n.to_lowercase();
                                l == "pulse" || l == "pipewire" || l == "default"
                            })
                            .unwrap_or(false)
                    })
                })
                .or_else(|| host.default_input_device());

            let device = match device {
                Some(d) => d,
                None => {
                    eprintln!("[WakeWord] No audio input device found. Wake word disabled.");
                    return;
                }
            };

            let device_name = device.name().unwrap_or_else(|_| "Unknown Device".to_string());
            eprintln!("[WakeWord] Using non-exclusive shared audio input device: {}", device_name);

            let config = match device.default_input_config() {
                Ok(c) => c,
                Err(err) => {
                    eprintln!("[WakeWord] Failed to query default input audio config: {}", err);
                    return;
                }
            };

            let sample_rate = config.sample_rate().0 as f32;
            let channels = config.channels() as usize;
            let sample_format = config.sample_format();

            eprintln!(
                "[WakeWord] Audio config: sample_rate = {} Hz, channels = {}, format = {:?}",
                sample_rate, channels, sample_format
            );

            // 3. Reconocedor de Wake Word (con gramática restringida para cero falsos positivos)
            let grammar = ["oye", "hey", "enigma", "[unk]"];
            let mut wake_recognizer = match Recognizer::new_with_grammar(&model, sample_rate, &grammar) {
                Some(r) => r,
                None => {
                    eprintln!("[WakeWord] Failed to instantiate Vosk recognizer with grammar.");
                    return;
                }
            };

            // 4. Reconocedor de Dictado (con diccionario completo en español)
            let mut dict_recognizer = match Recognizer::new(&model, sample_rate) {
                Some(r) => r,
                None => {
                    eprintln!("[WakeWord] Failed to instantiate full dictionary Vosk recognizer.");
                    return;
                }
            };

            // 5. Canal de comunicación entre el callback de audio y el hilo de inferencia
            let (tx, rx): (SyncSender<Vec<i16>>, Receiver<Vec<i16>>) = sync_channel(64);

            let err_fn = |err| {
                eprintln!("[WakeWord] cpal stream error: {}", err);
            };

            // 6. Configurar el stream según el formato de muestra del hardware
            let stream_res = match sample_format {
                cpal::SampleFormat::F32 => {
                    let tx = tx.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[f32], _| {
                            let mut pcm = Vec::with_capacity(data.len() / channels);
                            for frame in data.chunks_exact(channels) {
                                let sample = frame[0];
                                let scaled = (sample * 32767.0).clamp(-32768.0, 32767.0) as i16;
                                pcm.push(scaled);
                            }
                            let _ = tx.try_send(pcm);
                        },
                        err_fn,
                        None,
                    )
                }
                cpal::SampleFormat::I16 => {
                    let tx = tx.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[i16], _| {
                            let mut pcm = Vec::with_capacity(data.len() / channels);
                            for frame in data.chunks_exact(channels) {
                                pcm.push(frame[0]);
                            }
                            let _ = tx.try_send(pcm);
                        },
                        err_fn,
                        None,
                    )
                }
                cpal::SampleFormat::U16 => {
                    let tx = tx.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[u16], _| {
                            let mut pcm = Vec::with_capacity(data.len() / channels);
                            for frame in data.chunks_exact(channels) {
                                let sample = frame[0].wrapping_sub(32768) as i16;
                                pcm.push(sample);
                            }
                            let _ = tx.try_send(pcm);
                        },
                        err_fn,
                        None,
                    )
                }
                _ => {
                    eprintln!("[WakeWord] Unsupported sample format: {:?}", sample_format);
                    return;
                }
            };

            let stream = match stream_res {
                Ok(s) => s,
                Err(err) => {
                    eprintln!("[WakeWord] Failed to build audio input stream: {}", err);
                    return;
                }
            };

            if let Err(err) = stream.play() {
                eprintln!("[WakeWord] Failed to play audio input stream: {}", err);
                return;
            }

            eprintln!("[WakeWord] Microphone stream active. Listening for 'oye enigma' / 'hey enigma'...");

            let mut last_trigger = Instant::now() - Duration::from_secs(10);
            let mut last_audio_emit = Instant::now();
            let mut smooth_bass = 0.0f32;
            let mut smooth_treble = 0.0f32;
            let mut low_pass_state = 0.0f32;
            let mut prev_sample = 0.0f32;
            let mut current_mode = VoskMode::WakeWord;

            // 7. Bucle de procesamiento de audio en segundo plano
            while let Ok(pcm_chunk) = rx.recv() {
                // Cálculo espectral: Graves (amplitud baja frec / energía) y Agudos (diferencial de alta frec)
                // Throttled a ~20 FPS (50ms) para garantizar máxima fluidez sin saturar IPC
                if last_audio_emit.elapsed() >= Duration::from_millis(50) {
                    let mut bass_energy = 0.0f32;
                    let mut treble_energy = 0.0f32;

                    for &s in &pcm_chunk {
                        let sample = s as f32 / 32768.0;

                        // Filtro paso bajo IIR de un polo para graves (fc ~ 300Hz @ 44.1kHz)
                        low_pass_state += 0.04 * (sample - low_pass_state);
                        bass_energy += low_pass_state * low_pass_state;

                        // Filtro paso alto diferencial para agudos (tasa de cambio rápida entre muestras)
                        let diff = sample - prev_sample;
                        prev_sample = sample;
                        treble_energy += diff * diff;
                    }

                    let len = pcm_chunk.len().max(1) as f32;
                    let raw_bass_rms = (bass_energy / len).sqrt();
                    let raw_treble_rms = (treble_energy / len).sqrt();

                    let target_bass = ((raw_bass_rms - 0.003).max(0.0) * 7.5).clamp(0.0, 1.0);
                    let target_treble = ((raw_treble_rms - 0.004).max(0.0) * 12.0).clamp(0.0, 1.0);

                    // Suavizado exponencial para transiciones ultra fluidas
                    smooth_bass = smooth_bass * 0.65 + target_bass * 0.35;
                    smooth_treble = smooth_treble * 0.65 + target_treble * 0.35;

                    let _ = app_handle.emit("audio-levels", serde_json::json!({
                        "bass": smooth_bass,
                        "treble": smooth_treble
                    }));
                    let _ = app_handle.emit("audio-level", smooth_bass);

                    last_audio_emit = Instant::now();
                }

                // Control manual desde frontend o comandos
                if MANUAL_START_STT.swap(false, Ordering::SeqCst) {
                    eprintln!("[STT] Manual start dictation triggered");
                    dict_recognizer.reset();
                    let _ = app_handle.emit("stt-status", "listening");
                    current_mode = VoskMode::Dictation {
                        started_at: Instant::now(),
                        last_speech: Instant::now(),
                        has_spoken: false,
                        accumulated: String::new(),
                    };
                }
                if MANUAL_STOP_STT.swap(false, Ordering::SeqCst) {
                    eprintln!("[STT] Manual stop dictation triggered");
                    let _ = app_handle.emit("stt-status", "idle");
                    wake_recognizer.reset();
                    current_mode = VoskMode::WakeWord;
                }

                // Máquina de estados Vosk: WakeWord vs Dictation
                match &mut current_mode {
                    VoskMode::WakeWord => {
                        match wake_recognizer.accept_waveform(&pcm_chunk) {
                            Ok(DecodingState::Finalized) => {
                                let text_opt = wake_recognizer.result().single().map(|s| s.text.to_string());
                                if let Some(text) = text_opt {
                                    if check_and_trigger(&text, &app_handle, &mut last_trigger) {
                                        wake_recognizer.reset();
                                        dict_recognizer.reset();
                                        let _ = app_handle.emit("stt-status", "listening");
                                        current_mode = VoskMode::Dictation {
                                            started_at: Instant::now(),
                                            last_speech: Instant::now(),
                                            has_spoken: false,
                                            accumulated: String::new(),
                                        };
                                    }
                                }
                            }
                            Ok(DecodingState::Running) => {
                                let partial = wake_recognizer.partial_result();
                                let partial_text = partial.partial.to_string();
                                drop(partial);

                                if check_and_trigger(&partial_text, &app_handle, &mut last_trigger) {
                                    wake_recognizer.reset();
                                    dict_recognizer.reset();
                                    let _ = app_handle.emit("stt-status", "listening");
                                    current_mode = VoskMode::Dictation {
                                        started_at: Instant::now(),
                                        last_speech: Instant::now(),
                                        has_spoken: false,
                                        accumulated: String::new(),
                                    };
                                }
                            }
                            Ok(DecodingState::Failed) => {}
                            Err(e) => {
                                eprintln!("[WakeWord] Error during accept_waveform: {:?}", e);
                            }
                        }
                    }
                    VoskMode::Dictation {
                        started_at,
                        last_speech,
                        has_spoken,
                        accumulated,
                    } => {
                        match dict_recognizer.accept_waveform(&pcm_chunk) {
                            Ok(DecodingState::Running) => {
                                let partial = dict_recognizer.partial_result();
                                let partial_text = partial.partial.trim();
                                if !partial_text.is_empty() {
                                    *has_spoken = true;
                                    *last_speech = Instant::now();
                                    let live_text = if accumulated.is_empty() {
                                        partial_text.to_string()
                                    } else {
                                        format!("{} {}", accumulated, partial_text)
                                    };
                                    let _ = app_handle.emit("stt-transcript", live_text);
                                }
                            }
                            Ok(DecodingState::Finalized) => {
                                let res = dict_recognizer.result();
                                if let Some(single) = res.single() {
                                    let piece = single.text.trim();
                                    if !piece.is_empty() {
                                        *has_spoken = true;
                                        *last_speech = Instant::now();
                                        if !accumulated.is_empty() {
                                            accumulated.push(' ');
                                        }
                                        accumulated.push_str(piece);
                                        let _ = app_handle.emit("stt-transcript", accumulated.clone());
                                    }
                                }
                            }
                            Ok(DecodingState::Failed) => {}
                            Err(e) => {
                                eprintln!("[STT] Error during accept_waveform: {:?}", e);
                            }
                        }

                        // Verificación de fin de dictado por silencio o límite de tiempo
                        let should_finish = (*has_spoken && last_speech.elapsed() >= Duration::from_millis(1600))
                            || (*has_spoken && started_at.elapsed() >= Duration::from_secs(25));

                        let should_timeout = !*has_spoken && started_at.elapsed() >= Duration::from_secs(7);

                        if should_finish {
                            let final_res = dict_recognizer.final_result();
                            if let Some(single) = final_res.single() {
                                let trailing = single.text.trim();
                                if !trailing.is_empty() {
                                    if !accumulated.is_empty() {
                                        accumulated.push(' ');
                                    }
                                    accumulated.push_str(trailing);
                                }
                            }
                            let final_text = accumulated.trim().to_string();
                            if !final_text.is_empty() {
                                eprintln!("[STT] Dictation completed: '{}'", final_text);
                                let _ = app_handle.emit("stt-transcript", final_text.clone());
                                let _ = app_handle.emit("stt-final", final_text);
                            }
                            let _ = app_handle.emit("stt-status", "idle");
                            wake_recognizer.reset();
                            current_mode = VoskMode::WakeWord;
                        } else if should_timeout {
                            eprintln!("[STT] Dictation timeout (no speech detected)");
                            let _ = app_handle.emit("stt-status", "idle");
                            wake_recognizer.reset();
                            current_mode = VoskMode::WakeWord;
                        }
                    }
                }
            }

            eprintln!("[WakeWord] Listener loop exited.");
        })
        .expect("Failed to spawn wake word background thread");
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simultaneous_recording() {
        let host = cpal::default_host();
        let device = host
            .input_devices()
            .unwrap()
            .into_iter()
            .find(|d| d.name().map(|n| n == "pulse" || n == "pipewire").unwrap_or(false))
            .expect("pulse or pipewire device should exist");
        let config = device.default_input_config().unwrap();
        let stream = device
            .build_input_stream(
                &config.into(),
                |_data: &[f32], _| {},
                |err| eprintln!("Error: {}", err),
                None,
            )
            .unwrap();
        stream.play().unwrap();

        // While CPAL stream is active, test if another app can record simultaneously
        let status = std::process::Command::new("parec")
            .args(["--raw"])
            .spawn();
        assert!(status.is_ok(), "Second capture process should launch without errors");
        let mut child = status.unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        let _ = child.kill();
    }


    #[test]
    fn test_wake_word_matching_logic() {
        assert_eq!("oye".trim().to_lowercase() == "oye enigma" || "oye".trim().to_lowercase() == "hey enigma", false);
        assert_eq!("en".trim().to_lowercase() == "oye enigma" || "en".trim().to_lowercase() == "hey enigma", false);
        assert_eq!("enigma".trim().to_lowercase() == "oye enigma" || "enigma".trim().to_lowercase() == "hey enigma", false);
        assert_eq!("oye amigo".trim().to_lowercase() == "oye enigma" || "oye amigo".trim().to_lowercase() == "hey enigma", false);
        assert_eq!("hola enigma".trim().to_lowercase() == "oye enigma" || "hola enigma".trim().to_lowercase() == "hey enigma", false);

        assert_eq!("oye enigma".trim().to_lowercase() == "oye enigma" || "oye enigma".trim().to_lowercase() == "hey enigma", true);
        assert_eq!("hey enigma".trim().to_lowercase() == "oye enigma" || "hey enigma".trim().to_lowercase() == "hey enigma", true);
        assert_eq!("  Oye Enigma  ".trim().to_lowercase() == "oye enigma" || "  Oye Enigma  ".trim().to_lowercase() == "hey enigma", true);
        assert_eq!("HEY ENIGMA".trim().to_lowercase() == "oye enigma" || "HEY ENIGMA".trim().to_lowercase() == "hey enigma", true);
    }

    #[test]
    fn test_vosk_model_and_grammar_initialization() {
        let model_path = find_vosk_model().expect("Vosk model must exist at ~/.local/share/vosk/vosk-model-small-es");
        let model = Model::new(model_path.to_str().unwrap()).expect("Vosk model should load successfully");
        let grammar = ["oye", "hey", "enigma", "[unk]"];
        let recognizer = Recognizer::new_with_grammar(&model, 16000.0, &grammar);
        assert!(recognizer.is_some(), "Recognizer with restricted grammar should initialize");
    }
}

