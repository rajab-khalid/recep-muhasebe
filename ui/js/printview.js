// Print page of the phone app: shows the invoice / receipt / list made by the program, fitted to the screen,
// and prints it with the phone's own print window (printer or "Save as PDF").
(function () {
  var T = {
    tr: { back: 'Geri', print: 'Yazdır / PDF', none: 'Yazdırılacak bir şey bulunamadı. Geri dönüp tekrar deneyin.' },
    en: { back: 'Back', print: 'Print / PDF', none: 'Nothing to print was found. Go back and try again.' },
    ar: { back: 'رجوع', print: 'طباعة / PDF', none: 'لا يوجد شيء للطباعة. ارجع وحاول مرة أخرى.' },
    ku: { back: 'Vegere', print: 'Çap / PDF', none: 'Tiştek ji bo çapê nehat dîtin. Vegere û dîsa biceribîne.' },
  };
  var lang = 'tr';
  try { lang = localStorage.getItem('rm_lang') || 'tr'; } catch (e) { /* storage may be unavailable */ }
  if (!T[lang]) lang = 'tr';
  var L = T[lang];
  document.documentElement.lang = lang;

  var back = document.getElementById('rm-back');
  var printBtn = document.getElementById('rm-print');
  var page = document.getElementById('rm-page');
  back.textContent = (lang === 'ar' ? '→ ' : '← ') + L.back;
  back.addEventListener('click', function () { if (history.length > 1) history.back(); else location.replace('/'); });
  printBtn.textContent = L.print;
  printBtn.addEventListener('click', function () { window.print(); });

  var data = null;
  try { data = JSON.parse(sessionStorage.getItem('rm_print') || 'null'); } catch (e) { data = null; }
  if (!data || !data.html) {
    var msg = document.createElement('div');
    msg.className = 'rm-view-msg';
    msg.textContent = L.none;
    page.appendChild(msg);
    printBtn.disabled = true;
    return;
  }

  // the page made by the program: its styles, then its content (its own scripts never run here)
  var doc = new DOMParser().parseFromString(data.html, 'text/html');
  var styles = doc.head ? doc.head.querySelectorAll('style') : [];
  for (var i = 0; i < styles.length; i++) document.head.appendChild(document.importNode(styles[i], true));
  if (doc.title) document.title = doc.title;
  document.getElementById('rm-title').textContent = data.title || doc.title || '';
  var sheet = document.createElement('div');
  sheet.className = 'rm-sheet';
  sheet.setAttribute('dir', doc.documentElement.getAttribute('dir') || 'ltr');
  sheet.style.width = data.width || '190mm';
  var nodes = doc.body ? doc.body.childNodes : [];
  for (var j = 0; j < nodes.length; j++) {
    if (nodes[j].nodeName === 'SCRIPT') continue;
    sheet.appendChild(document.importNode(nodes[j], true));
  }
  page.appendChild(sheet);

  // a printed page is wider than a phone: shrink it on the screen only
  function fit() {
    sheet.style.zoom = '';
    var avail = page.clientWidth - 16;
    var w = Math.max(sheet.offsetWidth, sheet.scrollWidth); // the page's content may be wider than the paper
    if (avail > 0 && w > avail) sheet.style.zoom = String(Math.max(0.3, avail / w));
  }
  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('load', fit);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);

  if (data.auto) {
    var imgs = Array.prototype.slice.call(document.images);
    var waits = imgs.map(function (img) {
      return img.complete ? null : new Promise(function (r) { img.onload = r; img.onerror = r; setTimeout(r, 4000); });
    });
    Promise.all(waits)
      .then(function () { return document.fonts ? document.fonts.ready : null; })
      .then(function () { setTimeout(function () { try { window.print(); } catch (e) { /* the button stays */ } }, 300); });
  }
}());
