// The X11 desktop uses a tiled 1x1 root color and a small, input-transparent image window. Its pixmaps depend on the PNG dimensions, never the output resolution.
#include <stdio.h>
#include <stdlib.h>
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/shape.h>
#include <cairo/cairo-xlib.h>

#define BACKGROUND 0x9AA0A6UL

static int center(int screen, int image) {
    int difference = screen - image;
    return difference >= 0 ? difference / 2 : (difference - 1) / 2;
}

static void place_image(Display *display, Window root, Window image, int width, int height) {
    XWindowAttributes root_attr, image_attr;
    if (!XGetWindowAttributes(display, root, &root_attr) ||
            !XGetWindowAttributes(display, image, &image_attr)) {
        fprintf(stderr, "desktop background: cannot read window geometry\n");
        exit(1);
    }
    int x = center(root_attr.width, width), y = center(root_attr.height, height);
    if (image_attr.x != x || image_attr.y != y) {
        XMoveWindow(display, image, x, y);
    }

    // A browser can explicitly lower itself (the console's 'new windows to the front' switch). Restore the background below it without changing focus or creating a ConfigureNotify loop.
    Window parent, tree_root, *children = NULL;
    unsigned int count = 0;
    if (XQueryTree(display, root, &tree_root, &parent, &children, &count)) {
        if (count && children[0] != image) {
            XLowerWindow(display, image);
        }
        XFree(children);
    }
    XFlush(display);
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: x11-desktop-background IMAGE.png\n");
        return 1;
    }
    cairo_surface_t *png = cairo_image_surface_create_from_png(argv[1]);
    if (cairo_surface_status(png) != CAIRO_STATUS_SUCCESS) {
        fprintf(stderr, "desktop background: %s\n", cairo_status_to_string(cairo_surface_status(png)));
        cairo_surface_destroy(png);
        return 1;
    }
    int width = cairo_image_surface_get_width(png), height = cairo_image_surface_get_height(png);
    Display *display = XOpenDisplay(NULL);
    if (!display) {
        fprintf(stderr, "desktop background: cannot open DISPLAY\n");
        cairo_surface_destroy(png);
        return 1;
    }
    int shape_event, shape_error, shape_major, shape_minor;
    if (!XShapeQueryExtension(display, &shape_event, &shape_error) ||
            !XShapeQueryVersion(display, &shape_major, &shape_minor) ||
            (shape_major == 1 && shape_minor < 1)) {
        fprintf(stderr, "desktop background: SHAPE 1.1 is required for input transparency\n");
        cairo_surface_destroy(png);
        XCloseDisplay(display);
        return 1;
    }
    int screen = DefaultScreen(display);
    Window root = RootWindow(display, screen);
    unsigned int depth = DefaultDepth(display, screen);

    // Picom reads these properties and repeats the tiny pixmap across its output. Setting only the root window's background pixel would leave picom's desktop black.
    Pixmap color = XCreatePixmap(display, root, 1, 1, depth);
    GC gc = XCreateGC(display, color, 0, NULL);
    XSetForeground(display, gc, BACKGROUND);
    XFillRectangle(display, color, gc, 0, 0, 1, 1);
    XFreeGC(display, gc);
    const char *properties[] = {"_XROOTPMAP_ID", "ESETROOT_PMAP_ID"};
    for (unsigned int i = 0; i < sizeof(properties) / sizeof(properties[0]); ++i) {
        XChangeProperty(display, root, XInternAtom(display, properties[i], False),
            XA_PIXMAP, 32, PropModeReplace, (unsigned char *)&color, 1);
    }
    XSetWindowBackgroundPixmap(display, root, color);
    XClearWindow(display, root);

    Pixmap picture = XCreatePixmap(display, root, width, height, depth);
    cairo_surface_t *surface = cairo_xlib_surface_create(display, picture,
        DefaultVisual(display, screen), width, height);
    cairo_t *cairo = cairo_create(surface);
    cairo_set_source_rgb(cairo, 0x9A / 255.0, 0xA0 / 255.0, 0xA6 / 255.0);
    cairo_paint(cairo);
    cairo_set_source_surface(cairo, png, 0, 0);
    cairo_paint(cairo);
    cairo_surface_flush(surface);
    cairo_status_t status = cairo_status(cairo);
    cairo_destroy(cairo);
    cairo_surface_destroy(surface);
    cairo_surface_destroy(png);
    if (status != CAIRO_STATUS_SUCCESS) {
        fprintf(stderr, "desktop background: painting failed: %s\n", cairo_status_to_string(status));
        XCloseDisplay(display);
        return 1;
    }

    XSetWindowAttributes attributes = {.override_redirect = True, .background_pixmap = picture};
    Window image = XCreateWindow(display, root, 0, 0, width, height, 0, depth,
        InputOutput, DefaultVisual(display, screen), CWOverrideRedirect | CWBackPixmap, &attributes);
    XClassHint class_hint = {.res_name = "desktop-background", .res_class = "AgenteneDesktopBackground"};
    XSetClassHint(display, image, &class_hint);
    XStoreName(display, image, "Desktop background");
    XWMHints hints = {.flags = InputHint, .input = False};
    XSetWMHints(display, image, &hints);
    Atom desktop = XInternAtom(display, "_NET_WM_WINDOW_TYPE_DESKTOP", False);
    XChangeProperty(display, image, XInternAtom(display, "_NET_WM_WINDOW_TYPE", False),
        XA_ATOM, 32, PropModeReplace, (unsigned char *)&desktop, 1);
    XShapeCombineRectangles(display, image, ShapeInput, 0, 0, NULL, 0, ShapeSet, Unsorted);
    XSelectInput(display, root, StructureNotifyMask | SubstructureNotifyMask);
    XMapWindow(display, image);
    place_image(display, root, image, width, height);
    printf("desktop background: %dx%d image, 1x1 root tile\n", width, height);
    fflush(stdout);

    // The server repaints from the image pixmap. There are no retained decoded PNG rows, resize buffers or polling timers in this process.
    while (1) {
        XEvent event;
        XNextEvent(display, &event);
        while (XPending(display)) {
            XNextEvent(display, &event);
        }
        place_image(display, root, image, width, height);
    }
}
