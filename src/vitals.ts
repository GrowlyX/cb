/**
 * An expression that reads page-load timing, Largest Contentful Paint, Cumulative Layout Shift
 * and resource totals from the Performance API. Buffered observers replay entries recorded
 * before the probe ran; the short wait lets them deliver. Cross-origin resources only report a
 * transfer size when they send Timing-Allow-Origin.
 */
export function vitalsProbe(): string {
  return `new Promise((resolve) => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const paint = performance.getEntriesByName('first-contentful-paint')[0];
    const resources = performance.getEntriesByType('resource');
    let lcp;
    let cls = 0;

    const observe = (type, onEntry) => {
      try {
        const observer = new PerformanceObserver((list) => {
          list.getEntries().forEach(onEntry);
        });

        observer.observe({ type, buffered: true });
      } catch {
        return;
      }
    };

    observe('largest-contentful-paint', (entry) => {
      lcp = entry.startTime;
    });

    observe('layout-shift', (entry) => {
      if (!entry.hadRecentInput) {
        cls += entry.value;
      }
    });

    setTimeout(() => {
      const transfer = resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0);

      resolve({
        url: location.href,
        ttfbMs: navigation ? navigation.responseStart : undefined,
        fcpMs: paint ? paint.startTime : undefined,
        lcpMs: lcp,
        domContentLoadedMs: navigation ? navigation.domContentLoadedEventEnd : undefined,
        loadMs: navigation && navigation.loadEventEnd > 0 ? navigation.loadEventEnd : undefined,
        cls,
        resources: resources.length,
        transferKb: Math.round(transfer / 1024),
        jsHeapMb: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : undefined,
      });
    }, 300);
  })`;
}
