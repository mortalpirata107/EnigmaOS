/*
 * EnigmaOS - Wayland Strut Daemon (Layer Shell)
 *
 * Reserves an exclusive 48px top screen zone on KDE Plasma 6 / GNOME (Wayland)
 * using gtk-layer-shell while remaining 100% transparent and click-through,
 * allowing EnigmaOS's canvas to render floating over the desktop.
 */

#include <gtk/gtk.h>
#include <gtk-layer-shell.h>
#include <cairo.h>

static gboolean on_draw(GtkWidget *widget, cairo_t *cr, gpointer user_data) {
    (void)widget;
    (void)user_data;
    cairo_set_source_rgba(cr, 0.0, 0.0, 0.0, 0.0);
    cairo_set_operator(cr, CAIRO_OPERATOR_CLEAR);
    cairo_paint(cr);
    return FALSE;
}

int main(int argc, char **argv) {
    gtk_init(&argc, &argv);

    GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);

    // Initialize layer shell for Wayland compositor
    gtk_layer_init_for_window(GTK_WINDOW(window));

    // Anchor to top, left, and right screen edges
    gtk_layer_set_anchor(GTK_WINDOW(window), GTK_LAYER_SHELL_EDGE_TOP, TRUE);
    gtk_layer_set_anchor(GTK_WINDOW(window), GTK_LAYER_SHELL_EDGE_LEFT, TRUE);
    gtk_layer_set_anchor(GTK_WINDOW(window), GTK_LAYER_SHELL_EDGE_RIGHT, TRUE);

    // Establish exclusive zone reserved for the topbar: 48px
    gtk_layer_set_exclusive_zone(GTK_WINDOW(window), 48);

    // Set layer hierarchy to TOP
    gtk_layer_set_layer(GTK_WINDOW(window), GTK_LAYER_SHELL_LAYER_TOP);

    // Set dimensions: 2560px width x 48px height
    gtk_window_set_default_size(GTK_WINDOW(window), 2560, 48);
    gtk_widget_set_size_request(window, 2560, 48);

    // Configure RGBA visual for full transparency
    GdkScreen *screen = gtk_widget_get_screen(window);
    GdkVisual *visual = gdk_screen_get_rgba_visual(screen);
    if (visual) {
        gtk_widget_set_visual(window, visual);
    }
    gtk_widget_set_app_paintable(window, TRUE);
    g_signal_connect(G_OBJECT(window), "draw", G_CALLBACK(on_draw), NULL);

    // Realize and show window to allocate surface
    gtk_widget_show_all(window);

    // Configure input shape: pass-through all pointer events (empty region)
    cairo_region_t *empty_region = cairo_region_create();
    gtk_widget_input_shape_combine_region(window, empty_region);
    cairo_region_destroy(empty_region);

    g_signal_connect(G_OBJECT(window), "destroy", G_CALLBACK(gtk_main_quit), NULL);

    gtk_main();
    return 0;
}
