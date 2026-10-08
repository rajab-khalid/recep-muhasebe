'use strict';
/* The few sentences the desktop shell itself shows (dialogs, right-click menu), in the interface language. */
const S = {
  tr: {
    update_title: 'Güncelleme hazır', update_ready: (v) => `Yeni sürüm (${v}) indirildi.`,
    update_detail: 'Program şimdi yeniden başlatılıp güncellensin mi? "Sonra" derseniz program kapanırken kendiliğinden güncellenir. Güncellemeden önce verilerinizin yedeği alındı.',
    restart_now: 'Şimdi yeniden başlat', later: 'Sonra',
    start_failed: 'Program başlatılamadı', start_failed_detail: (dir, err) => `Veri klasörü: ${dir}\n\n${err}\n\nVerileriniz silinmedi. Bilgisayarı yeniden başlatıp tekrar deneyin; düzelmezse bu mesajın fotoğrafını gönderin.`,
    cut: 'Kes', copy: 'Kopyala', paste: 'Yapıştır', select_all: 'Tümünü seç', undo: 'Geri al', redo: 'Yinele',
  },
  en: {
    update_title: 'Update ready', update_ready: (v) => `Version ${v} has been downloaded.`,
    update_detail: 'Restart the program now to install it? If you choose "Later", it installs itself when you close the program. Your data was backed up before the update.',
    restart_now: 'Restart now', later: 'Later',
    start_failed: 'The program could not start', start_failed_detail: (dir, err) => `Data folder: ${dir}\n\n${err}\n\nYour data has not been deleted. Restart the computer and try again; if it still fails, send a photo of this message.`,
    cut: 'Cut', copy: 'Copy', paste: 'Paste', select_all: 'Select all', undo: 'Undo', redo: 'Redo',
  },
  ar: {
    update_title: 'التحديث جاهز', update_ready: (v) => `تم تنزيل الإصدار الجديد (${v}).`,
    update_detail: 'هل تريد إعادة تشغيل البرنامج الآن لتثبيت التحديث؟ إذا اخترت "لاحقًا" فسيُثبَّت تلقائيًا عند إغلاق البرنامج. تم أخذ نسخة احتياطية من بياناتك قبل التحديث.',
    restart_now: 'إعادة التشغيل الآن', later: 'لاحقًا',
    start_failed: 'تعذّر تشغيل البرنامج', start_failed_detail: (dir, err) => `مجلد البيانات: ${dir}\n\n${err}\n\nلم تُحذف بياناتك. أعد تشغيل الحاسوب وحاول مرة أخرى؛ وإذا استمرت المشكلة أرسل صورة لهذه الرسالة.`,
    cut: 'قص', copy: 'نسخ', paste: 'لصق', select_all: 'تحديد الكل', undo: 'تراجع', redo: 'إعادة',
  },
  ku: {
    update_title: 'Nûkirin amade ye', update_ready: (v) => `Guhertoya nû (${v}) hate daxistin.`,
    update_detail: 'Bila bername niha ji nû ve dest pê bike û were nûkirin? Ger tu "Paşê" hilbijêrî, dema bername tê girtin bi xwe tê nûkirin. Berî nûkirinê paşkeftiya daneyên te hate girtin.',
    restart_now: 'Niha ji nû ve dest pê bike', later: 'Paşê',
    start_failed: 'Bername dest pê nekir', start_failed_detail: (dir, err) => `Peldanka daneyan: ${dir}\n\n${err}\n\nDaneyên te nehatine jêbirin. Komputerê ji nû ve vekirin û dîsa biceribîne; ger dîsa nebû, wêneyê vê peyamê bişîne.`,
    cut: 'Bibire', copy: 'Kopî bike', paste: 'Pêve bike', select_all: 'Hemûyan hilbijêre', undo: 'Vegerîne', redo: 'Dîsa bike',
  },
};
module.exports = (lang) => S[lang] || S.tr;
