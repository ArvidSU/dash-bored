#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

// A transparent AppKit hit-test surface. Only shell drag regions intercept
// input; every control, overlay and dashboard point passes to the webview.
@interface DBWindowDragView : NSView
@property(nonatomic, copy) NSDictionary *regions;
@property(nonatomic) BOOL dragging;
@property(nonatomic) NSPoint pointerOffset;
@end

static NSPoint screenPoint(NSEvent *event, NSWindow *window) {
  CGEventRef native = event.CGEvent;
  if (!native) return [window convertPointToScreen:event.locationInWindow];
  CGPoint point = CGEventGetLocation(native);
  // Quartz's global origin is the primary display's top-left; AppKit's is
  // its bottom-left. Keep the event's original global point even if earlier
  // queued events have already changed the window frame.
  return NSMakePoint(point.x, NSMaxY(NSScreen.screens.firstObject.frame) - point.y);
}

@implementation DBWindowDragView
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (BOOL)mouseDownCanMoveWindow { return NO; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (BOOL)containsPoint:(NSPoint)point inRects:(NSArray *)rects {
  for (NSDictionary *rect in rects) {
    if (NSPointInRect(point, NSMakeRect([rect[@"x"] doubleValue], [rect[@"y"] doubleValue],
                                      [rect[@"width"] doubleValue], [rect[@"height"] doubleValue]))) return YES;
  }
  return NO;
}
- (NSView *)hitTest:(NSPoint)point {
  NSPoint local = [self convertPoint:point fromView:self.superview];
  if (!NSPointInRect(local, self.bounds) || self.hidden || !self.regions) return nil;
  // Native traffic lights always keep their own hit testing, even when their
  // inset or view hierarchy changes in a later Electrobun version.
  for (NSNumber *kind in @[@(NSWindowCloseButton), @(NSWindowMiniaturizeButton), @(NSWindowZoomButton)]) {
    NSButton *button = [self.window standardWindowButton:kind.unsignedIntegerValue];
    if (button && !button.hidden && NSPointInRect(local, [button convertRect:button.bounds toView:self])) return nil;
  }
  double width = [self.regions[@"width"] doubleValue];
  double height = [self.regions[@"height"] doubleValue];
  if (width <= 0 || height <= 0 || self.bounds.size.width <= 0 || self.bounds.size.height <= 0) return nil;
  NSPoint css = NSMakePoint(local.x * width / self.bounds.size.width,
                           local.y * height / self.bounds.size.height);
  if ([self containsPoint:css inRects:self.regions[@"exclude"]]) return nil;
  return [self containsPoint:css inRects:self.regions[@"drag"]] ? self : nil;
}
- (void)mouseDown:(NSEvent *)event {
  // Keep the original AppKit responder gesture on the main thread. Registering
  // asynchronous event monitors from a webview RPC loses short drags; AppKit's
  // modal performWindowDragWithEvent also rejects some injected mouse events.
  NSPoint pointer = screenPoint(event, self.window);
  self.pointerOffset = NSMakePoint(pointer.x - self.window.frame.origin.x,
                                   pointer.y - self.window.frame.origin.y);
  self.dragging = YES;
}
- (void)mouseDragged:(NSEvent *)event {
  if (!self.dragging || (self.window.styleMask & NSWindowStyleMaskFullScreen)) return;
  // Use the event's global position independently of the changing window frame.
  NSPoint pointer = screenPoint(event, self.window);
  [self.window setFrameOrigin:NSMakePoint(pointer.x - self.pointerOffset.x,
                                          pointer.y - self.pointerOffset.y)];
}
- (void)mouseUp:(NSEvent *)event {
  self.dragging = NO;
}
@end

static char dragViewKey;

void db_set_window_drag_regions(void *pointer, const char *json) {
  @autoreleasepool {
    NSWindow *window = (__bridge NSWindow *)pointer;
    NSString *source = json ? [NSString stringWithUTF8String:json] : nil;
    NSDictionary *regions = source ? [NSJSONSerialization JSONObjectWithData:[source dataUsingEncoding:NSUTF8StringEncoding]
                                                                   options:0 error:nil] : nil;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (!window.contentView) return;
      DBWindowDragView *view = objc_getAssociatedObject(window, &dragViewKey);
      if (!view) {
        view = [[DBWindowDragView alloc] initWithFrame:window.contentView.bounds];
        view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        objc_setAssociatedObject(window, &dragViewKey, view, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        [window.contentView addSubview:view positioned:NSWindowAbove relativeTo:nil];
      }
      view.regions = regions;
    });
  }
}
