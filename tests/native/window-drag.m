#import "../../src/native/window-drag.m"
#include <assert.h>

static NSView *hit(DBWindowDragView *view, CGFloat x, CGFloat y) {
  return [view hitTest:[view convertPoint:NSMakePoint(x, y) toView:view.superview]];
}

static NSEvent *mouse(NSWindow *window, NSEventType type, NSPoint location) {
  NSPoint global = [window convertPointToScreen:location];
  CGPoint quartz = CGPointMake(global.x, NSMaxY(NSScreen.screens.firstObject.frame) - global.y);
  CGEventType eventType = type == NSEventTypeLeftMouseDown ? kCGEventLeftMouseDown
    : type == NSEventTypeLeftMouseUp ? kCGEventLeftMouseUp : kCGEventLeftMouseDragged;
  CGEventRef native = CGEventCreateMouseEvent(NULL, eventType, quartz, kCGMouseButtonLeft);
  NSEvent *event = [NSEvent eventWithCGEvent:native];
  CFRelease(native);
  return event;
}

int main(void) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    // Never shown, activated, or sent OS input: these are AppKit unit events.
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 200, 800, 600)
       styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskFullSizeContentView
       backing:NSBackingStoreBuffered defer:NO];
    DBWindowDragView *view = [[DBWindowDragView alloc] initWithFrame:window.contentView.bounds];
    [window.contentView addSubview:view];
    view.regions = @{@"width": @800, @"height": @600,
      @"drag": @[@{@"x": @0, @"y": @0, @"width": @800, @"height": @60}],
      @"exclude": @[@{@"x": @600, @"y": @10, @"width": @180, @"height": @40}]};
    assert([view acceptsFirstMouse:nil]);
    assert(hit(view, 300, 30) == view);
    assert(hit(view, 650, 30) == nil); // Header controls.
    assert(hit(view, 300, 100) == nil); // Dashboard content.
    NSButton *close = [window standardWindowButton:NSWindowCloseButton];
    NSRect closeRect = [close convertRect:close.bounds toView:view];
    assert(hit(view, NSMidX(closeRect), NSMidY(closeRect)) == nil);

    NSPoint origin = window.frame.origin;
    NSPoint down = [view convertPoint:NSMakePoint(300, 30) toView:nil];
    [view mouseDown:mouse(window, NSEventTypeLeftMouseDown, down)];
    [view mouseDragged:mouse(window, NSEventTypeLeftMouseDragged, NSMakePoint(down.x + 40, down.y - 25))];
    assert(window.frame.origin.x == origin.x + 40);
    assert(window.frame.origin.y == origin.y - 25);
    [view mouseUp:mouse(window, NSEventTypeLeftMouseUp, down)];
    NSPoint released = window.frame.origin;
    [view mouseDragged:mouse(window, NSEventTypeLeftMouseDragged, down)];
    assert(NSEqualPoints(released, window.frame.origin));
    // A fresh gesture replaces the previous offset rather than accumulating it.
    [view mouseDown:mouse(window, NSEventTypeLeftMouseDown, down)];
    [view mouseDragged:mouse(window, NSEventTypeLeftMouseDragged, NSMakePoint(down.x - 10, down.y + 5))];
    assert(window.frame.origin.x == released.x - 10);
    assert(window.frame.origin.y == released.y + 5);
    [view mouseUp:mouse(window, NSEventTypeLeftMouseUp, down)];

    // Both events can be queued against the same window frame. Converting
    // their local points against the frame after the first move overshoots.
    NSPoint beforeQueue = window.frame.origin;
    [view mouseDown:mouse(window, NSEventTypeLeftMouseDown, down)];
    NSEvent *first = mouse(window, NSEventTypeLeftMouseDragged, NSMakePoint(down.x + 40, down.y - 15));
    NSEvent *second = mouse(window, NSEventTypeLeftMouseDragged, NSMakePoint(down.x + 80, down.y - 30));
    [view mouseDragged:first];
    [view mouseDragged:second];
    assert(window.frame.origin.x == beforeQueue.x + 80);
    assert(window.frame.origin.y == beforeQueue.y - 30);
    [view mouseUp:mouse(window, NSEventTypeLeftMouseUp, down)];

    // Native resizing can precede the renderer's next viewport measurement.
    NSRect fullBounds = view.frame;
    [view setFrameSize:NSMakeSize(400, 300)];
    assert(hit(view, 150, 15) == view);
    assert(hit(view, 325, 15) == nil);
    assert(hit(view, 150, 50) == nil);
    view.frame = fullBounds;

    // Empty geometry disables interception under modal backdrops.
    view.regions = @{@"width": @800, @"height": @600, @"drag": @[], @"exclude": @[]};
    assert(hit(view, 300, 30) == nil);
    puts("Native window drag hit testing and repeated gestures passed.");
  }
}
