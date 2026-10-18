#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <gtk/gtk.h>
#include <gdk/gdkwayland.h>
#include <wayland-client.h>
#include <stdint.h>
#include <stdio.h>
#include <dlfcn.h>

#ifndef RTLD_DEFAULT
#define RTLD_DEFAULT ((void *) 0)
#endif

// Forward declaration from gtk-layer-shell
extern int gtk_layer_is_layer_window(GtkWindow *window);

/**
 * Sets the Wayland input region directly on the wl_surface and commits to the compositor.
 * rects is a contiguous array of int32_t with 4 ints per rect: [x, y, width, height].
 * count is the number of rectangles.
 * If count == 0, an empty wl_region is created and set, making the surface 100% click-through.
 *
 * Returns:
 *   0 on success
 *  -1 window is NULL
 *  -2 gdk_win is NULL (window not realized or mapped yet)
 *  -3 not a Wayland window (running under X11/XWayland fallback)
 *  -4 wl_surface is NULL
 *  -5 not a Wayland display
 *  -6 wl_compositor is NULL
 *  -7 failed to create wl_region
 */
int set_native_wayland_input_regions(GtkWindow *window, const int32_t *rects, int count) {
    if (!window) return -1;
    GtkWidget *widget = GTK_WIDGET(window);
    if (!gtk_widget_get_realized(widget)) {
        gtk_widget_realize(widget);
    }
    GdkWindow *gdk_win = gtk_widget_get_window(widget);
    if (!gdk_win) return -2;

    if (!GDK_IS_WAYLAND_WINDOW(gdk_win)) return -3;

    struct wl_surface *wl_surf = gdk_wayland_window_get_wl_surface(gdk_win);
    if (!wl_surf) return -4;

    GdkDisplay *display = gtk_widget_get_display(widget);
    if (!display || !GDK_IS_WAYLAND_DISPLAY(display)) return -5;

    struct wl_compositor *compositor = gdk_wayland_display_get_wl_compositor(display);
    if (!compositor) return -6;

    struct wl_display *wl_disp = gdk_wayland_display_get_wl_display(display);

    // Create a new wl_region
    struct wl_region *region = wl_compositor_create_region(compositor);
    if (!region) return -7;

    if (rects && count > 0) {
        for (int i = 0; i < count; i++) {
            int32_t x = rects[i * 4 + 0];
            int32_t y = rects[i * 4 + 1];
            int32_t w = rects[i * 4 + 2];
            int32_t h = rects[i * 4 + 3];
            if (w > 0 && h > 0) {
                wl_region_add(region, x, y, w, h);
            }
        }
    }

    // Set the input region on the Wayland surface (double-buffered in Wayland)
    wl_surface_set_input_region(wl_surf, region);

    // Destroy the client-side region proxy (the compositor retains its copy)
    wl_region_destroy(region);

    // If gtk_layer_try_force_commit is supported in the loaded gtk-layer-shell version (0.9+),
    // resolve it dynamically via dlsym to maintain universal compatibility with older distros (e.g. Ubuntu 22.04)
    typedef void (*gtk_layer_try_force_commit_fn)(GtkWindow *);
    static gtk_layer_try_force_commit_fn try_force_commit = NULL;
    static int probed = 0;
    if (!probed) {
        try_force_commit = (gtk_layer_try_force_commit_fn)dlsym(RTLD_DEFAULT, "gtk_layer_try_force_commit");
        probed = 1;
    }

    if (gtk_layer_is_layer_window(window)) {
        if (try_force_commit) {
            try_force_commit(window);
        } else {
            wl_surface_commit(wl_surf);
        }
    } else {
        wl_surface_commit(wl_surf);
    }
    gtk_widget_queue_draw(widget);

    // CRITICAL: Flush Wayland socket buffer immediately so compositor receives the input region
    if (wl_disp) {
        wl_display_flush(wl_disp);
    }
    gdk_display_flush(display);

    return 0;
}
