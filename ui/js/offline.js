// "Cannot reach the shop computer" page of the phone app: in the app's language, and it opens the program
// again by itself as soon as the computer answers.
(function () {
  var T = {
    tr: {
      title: 'Dükkândaki bilgisayara ulaşılamıyor',
      text: 'Telefon, Recep Muhasebe\'nin çalıştığı bilgisayara bağlanamadı. Şunlara bakın:',
      c1: 'Dükkândaki bilgisayar açık ve Recep Muhasebe çalışıyor mu?',
      c2: 'Telefonda Tailscale açık ve "Connected" (bağlı) görünüyor mu?',
      c3: 'Telefonda internet var mı?',
      retry: 'Tekrar dene', trying: 'Bağlanmaya çalışılıyor…', waiting: 'Bilgisayar açılınca program kendiliğinden açılacak.',
    },
    en: {
      title: 'Cannot reach the shop computer',
      text: 'The phone could not connect to the computer running Recep Muhasebe. Please check:',
      c1: 'Is the shop computer on, with Recep Muhasebe running?',
      c2: 'Is Tailscale on in the phone and does it show "Connected"?',
      c3: 'Does the phone have internet?',
      retry: 'Try again', trying: 'Connecting…', waiting: 'The program opens by itself as soon as the computer answers.',
    },
    ar: {
      title: 'تعذّر الوصول إلى حاسوب المحل',
      text: 'لم يتمكن الهاتف من الاتصال بالحاسوب الذي يعمل عليه برنامج Recep Muhasebe. تحقّق من:',
      c1: 'هل حاسوب المحل يعمل والبرنامج مفتوح؟',
      c2: 'هل تطبيق Tailscale مفعّل في الهاتف ويظهر "Connected" (متصل)؟',
      c3: 'هل يوجد إنترنت في الهاتف؟',
      retry: 'إعادة المحاولة', trying: 'جارٍ الاتصال…', waiting: 'سيفتح البرنامج تلقائيًا عندما يستجيب الحاسوب.',
    },
    ku: {
      title: 'Nikare bigihîje komputera dikanê',
      text: 'Telefon nikarî bi wê komputerê ve girê bide ku Recep Muhasebe li ser dixebite. Van tiştan kontrol bike:',
      c1: 'Ma komputera dikanê vekirî ye û Recep Muhasebe dixebite?',
      c2: 'Ma Tailscale di telefonê de vekirî ye û "Connected" (girêdayî) xuya dike?',
      c3: 'Ma înternet di telefonê de heye?',
      retry: 'Dîsa biceribîne', trying: 'Girêdan tê ceribandin…', waiting: 'Gava komputer bersiv bide, program bi xwe vedibe.',
    },
  };
  var lang = 'tr';
  try { lang = localStorage.getItem('rm_lang') || 'tr'; } catch (e) { /* storage may be unavailable */ }
  if (!T[lang]) lang = 'tr';
  var d = T[lang];
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  var nodes = document.querySelectorAll('[data-t]');
  for (var i = 0; i < nodes.length; i++) nodes[i].textContent = d[nodes[i].getAttribute('data-t')];
  var status = document.getElementById('status');
  status.textContent = d.waiting;

  var busy = false;
  function check(manual) {
    if (busy) return;
    busy = true;
    if (manual) status.textContent = d.trying;
    fetch('/api/ping', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('down');
        // opened as its own page (no copy on the phone): back to the program; shown in its place: reload it
        if (location.pathname === '/offline.html') location.replace('/'); else location.reload();
      })
      .catch(function () { status.textContent = d.waiting; })
      .then(function () { busy = false; });
  }
  document.getElementById('retry').addEventListener('click', function () { check(true); });
  setInterval(function () { if (!document.hidden) check(false); }, 6000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(false); });
}());
