/**
 * pawservation embed loader — dependency-free, paste-into-any-CMS.
 *
 *   <script src="https://<worker>/embed.js" data-pawservation-tenant="your-slug"></script>
 *
 * Injects the booking-widget iframe where the script tag sits, auto-resizes it via
 * origin-checked postMessage, and re-dispatches booking events on window as a
 * `pawservation:booked` DOM CustomEvent, so host-page listeners keep working. Hosts that
 * strip scripts (or Wix "Embed a site") use the plain-iframe variant instead.
 */
/* global document, window, URL, CustomEvent, console */
(function () {
  var script =
    document.currentScript ||
    (function () {
      var candidates = document.querySelectorAll('script[data-pawservation-tenant]');
      return candidates[candidates.length - 1];
    })();
  if (!script) return;
  var slug = script.getAttribute('data-pawservation-tenant');
  if (!slug) {
    console.error('pawservation embed: data-pawservation-tenant attribute is required');
    return;
  }

  var widgetOrigin = new URL(script.src).origin;
  var iframe = document.createElement('iframe');
  iframe.src = widgetOrigin + '/embed/' + encodeURIComponent(slug);
  iframe.title = 'Booking widget';
  iframe.style.width = '100%';
  iframe.style.border = '0';
  iframe.style.height = (parseInt(script.getAttribute('data-height'), 10) || 480) + 'px';
  script.parentNode.insertBefore(iframe, script.nextSibling);

  window.addEventListener('message', function (event) {
    // Only accept messages from OUR origin AND our specific iframe.
    if (event.origin !== widgetOrigin || event.source !== iframe.contentWindow) return;
    var data = event.data || {};
    if (data.type === 'pawservation:resize' && typeof data.height === 'number') {
      iframe.style.height = Math.max(240, Math.min(2000, Math.ceil(data.height))) + 'px';
    } else if (data.type === 'pawservation:booked') {
      var detail = { detail: { requestId: data.requestId } };
      window.dispatchEvent(new CustomEvent('pawservation:booked', detail));
    }
  });
})();
