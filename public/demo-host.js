/* global document, window, setTimeout */
// Host-page handler for the fake-CMS demo: the loader re-dispatches widget bookings as
// DOM events; a real customer site could hook these the same way. Listening for the NEW
// event name here is the manual proof it fires (the loader also dispatches the legacy
// `pawbook:booked` alias for pre-rebrand host pages).
window.addEventListener('pawservation:booked', function (event) {
  var toast = document.getElementById('toast');
  toast.textContent = 'Booking request received: ' + event.detail.requestId;
  toast.classList.add('show');
  setTimeout(function () {
    toast.classList.remove('show');
  }, 4000);
});
