/**
 * pawservation embed loader — dependency-free, paste-into-any-CMS.
 *
 *   <script src="https://<worker>/embed.js" data-pawservation-tenant="your-slug"></script>
 *
 * The pre-rebrand attribute `data-pawbook-tenant` is honored forever — snippets already
 * pasted into sitters' sites are never revisited. The widget posts BOTH message families
 * (`pawservation:resize`/`pawservation:booked` and legacy `pawbook:resize`/`pawbook:booked`)
 * because host pages may serve an HTTP-cached pre-rebrand copy of this file; THIS loader
 * reacts to the pawservation family only, legacy loaders react only to `pawbook:resize` /
 * `pawbook:booked`, so no loader vintage ever double-handles a message.
 *
 * Injects the booking-widget iframe where the script tag sits, auto-resizes it via
 * origin-checked postMessage, and re-dispatches booking events on window as BOTH the
 * `pawservation:booked` and legacy `pawbook:booked` DOM CustomEvents, so existing
 * host-page listeners keep working. Hosts that strip scripts (or Wix "Embed a site")
 * use the plain-iframe variant instead.
 */
/* global document, window, URL, CustomEvent, console */
(function () {
  var script =
    document.currentScript ||
    (function () {
      var candidates = document.querySelectorAll(
        'script[data-pawservation-tenant],script[data-pawbook-tenant]',
      );
      return candidates[candidates.length - 1];
    })();
  if (!script) return;
  // New attribute wins when both are present; legacy `data-pawbook-tenant` supported forever.
  var slug =
    script.getAttribute('data-pawservation-tenant') || script.getAttribute('data-pawbook-tenant');
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
      // Legacy alias `pawbook:booked` — pre-rebrand host pages listen for this. Forever.
      window.dispatchEvent(new CustomEvent('pawbook:booked', detail));
    }
  });
})();
