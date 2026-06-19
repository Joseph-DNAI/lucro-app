// Scroll reveal
var reveals = document.querySelectorAll('.reveal');
var observer = new IntersectionObserver(function(entries) {
  entries.forEach(function(e) {
    if (e.isIntersecting) { e.target.classList.add('visible'); observer.unobserve(e.target); }
  });
}, { threshold: 0.1 });
reveals.forEach(function(el) { observer.observe(el); });

// Hide sticky CTA when price section is visible
var priceCard = document.querySelector('.price-section');
var stickyCTA = document.querySelector('.sticky-cta');
var priceObs = new IntersectionObserver(function(entries) {
  entries.forEach(function(e) {
    if (stickyCTA) stickyCTA.style.display = e.isIntersecting ? 'none' : '';
  });
}, { threshold: 0.3 });
if (priceCard && stickyCTA) priceObs.observe(priceCard);

// Tutorial tabs
function switchTab(tab, el) {
  document.querySelectorAll('.ttab').forEach(function(b) { b.classList.remove('active'); });
  document.querySelectorAll('.tutorial-panel').forEach(function(p) { p.classList.remove('active'); });
  el.classList.add('active');
  document.getElementById('panel-' + tab).classList.add('active');
}
