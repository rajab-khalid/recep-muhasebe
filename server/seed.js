'use strict';
/* Default data written once by the setup wizard (or by the old-data import), in the chosen language. */

const NAMES = {
  warehouse_main: { tr: 'Ana Depo', en: 'Main Warehouse', ar: 'المستودع الرئيسي', ku: 'Depoya Sereke' },
  cash_usd: { tr: 'Kasa USD', en: 'Cash USD', ar: 'الصندوق دولار', ku: 'Kasa USD' },
  cash_iqd: { tr: 'Kasa IQD', en: 'Cash IQD', ar: 'الصندوق دينار', ku: 'Kasa IQD' },
  walkin: { tr: 'Perakende Müşteri', en: 'Walk-in Customer', ar: 'زبون نقدي', ku: 'Kirriyarê Kaş' },
  pl_retail: { tr: 'Perakende', en: 'Retail', ar: 'مفرد', ku: 'Firotina Tak' },
  pl_wholesale: { tr: 'Toptan', en: 'Wholesale', ar: 'جملة', ku: 'Kom' },
  pl_special: { tr: 'Özel Müşteri', en: 'Special Customer', ar: 'زبون خاص', ku: 'Kirriyarê Taybet' },
  pl_service: { tr: 'Servis / Usta', en: 'Service / Mechanic', ar: 'خدمة / فني', ku: 'Servîs / Hosta' },
  unit: { tr: 'adet', en: 'pcs', ar: 'قطعة', ku: 'dane' },
};

const FINANCE_CATEGORIES = [
  // code, kind, in_pl, names
  ['rent', 'expense', 1, { tr: 'Kira', en: 'Rent', ar: 'إيجار', ku: 'Kirê' }],
  ['salary', 'expense', 1, { tr: 'Maaş', en: 'Salaries', ar: 'رواتب', ku: 'Meaş' }],
  ['commission', 'expense', 1, { tr: 'Prim / Komisyon', en: 'Commission / Bonus', ar: 'عمولة / مكافأة', ku: 'Prîm / Komîsyon' }],
  ['electricity', 'expense', 1, { tr: 'Elektrik / Jeneratör', en: 'Electricity / Generator', ar: 'كهرباء / مولدة', ku: 'Ken / Mûlîde' }],
  ['water', 'expense', 1, { tr: 'Su', en: 'Water', ar: 'ماء', ku: 'Av' }],
  ['internet', 'expense', 1, { tr: 'İnternet / Telefon', en: 'Internet / Phone', ar: 'إنترنت / هاتف', ku: 'Înternet / Telefon' }],
  ['fuel', 'expense', 1, { tr: 'Yakıt', en: 'Fuel', ar: 'وقود', ku: 'Sotemenî' }],
  ['transport', 'expense', 1, { tr: 'Nakliye / Kargo', en: 'Shipping / Transport', ar: 'نقل / شحن', ku: 'Veguhastin' }],
  ['maintenance', 'expense', 1, { tr: 'Bakım / Onarım', en: 'Maintenance / Repair', ar: 'صيانة / تصليح', ku: 'Tamîrat' }],
  ['marketing', 'expense', 1, { tr: 'Reklam', en: 'Advertising', ar: 'إعلان', ku: 'Reklam' }],
  ['tax', 'expense', 1, { tr: 'Vergi / Harç', en: 'Taxes / Fees', ar: 'ضرائب / رسوم', ku: 'Bac / Xerc' }],
  ['food', 'expense', 1, { tr: 'Mutfak / Yemek', en: 'Kitchen / Meals', ar: 'مطبخ / طعام', ku: 'Xwarin' }],
  ['other', 'expense', 1, { tr: 'Diğer Gider', en: 'Other Expense', ar: 'مصاريف أخرى', ku: 'Mesrefên Din' }],
  ['owner_draw', 'expense', 0, { tr: 'Patron Çekimi (kâr dışı)', en: 'Owner Withdrawal (not P&L)', ar: 'سحب المالك (خارج الأرباح)', ku: 'Kişandina Xwedî (ne P&L)' }],
  ['other_income', 'income', 1, { tr: 'Diğer Gelir', en: 'Other Income', ar: 'إيرادات أخرى', ku: 'Dahata Din' }],
  ['capital', 'income', 0, { tr: 'Sermaye Girişi (kâr dışı)', en: 'Capital Injection (not P&L)', ar: 'إدخال رأس مال (خارج الأرباح)', ku: 'Sermaye (ne P&L)' }],
];

const PRODUCT_CATEGORIES = [
  { tr: 'Temizlik ve Bakım (Detailing)', en: 'Cleaning & Care (Detailing)', ar: 'تنظيف وعناية', ku: 'Paqijî û Xweyîkirin' },
  { tr: 'Koltuk Kılıfı ve Döşeme', en: 'Seat Covers & Upholstery', ar: 'تلبيس مقاعد', ku: 'Bergên Kursiyan' },
  { tr: 'Paspas', en: 'Floor Mats', ar: 'دواسات', ku: 'Paspas' },
  { tr: 'Aydınlatma (LED / Xenon)', en: 'Lighting (LED / Xenon)', ar: 'إضاءة (LED / زينون)', ku: 'Ronahî (LED / Xenon)' },
  { tr: 'Multimedya ve Ekran', en: 'Multimedia & Screens', ar: 'شاشات ووسائط', ku: 'Multîmedya û Ekran' },
  { tr: 'Ses Sistemi', en: 'Audio', ar: 'أنظمة صوت', ku: 'Sîstema Deng' },
  { tr: 'Kamera ve Sensör', en: 'Cameras & Sensors', ar: 'كاميرات وحساسات', ku: 'Kamera û Sensor' },
  { tr: 'İç Aksesuar', en: 'Interior Accessories', ar: 'إكسسوارات داخلية', ku: 'Aksesuarên Hundir' },
  { tr: 'Dış Aksesuar', en: 'Exterior Accessories', ar: 'إكسسوارات خارجية', ku: 'Aksesuarên Derve' },
  { tr: 'Koruma Filmi ve Kaplama', en: 'Protection Film & Coating', ar: 'أفلام حماية وطلاء', ku: 'Fîlma Parastinê' },
  { tr: 'Elektrik', en: 'Electrical', ar: 'كهربائيات', ku: 'Kehreba' },
  { tr: 'Diğer', en: 'Other', ar: 'أخرى', ku: 'Yên Din' },
];

const VEHICLES = {
  Toyota: ['Corolla', 'Camry', 'Land Cruiser', 'Land Cruiser Prado', 'Hilux', 'RAV4', 'Yaris', 'Avalon', 'Fortuner', 'Highlander', 'Sequoia', 'Tundra', 'FJ Cruiser', '4Runner', 'Crown', 'Rush', 'C-HR'],
  Hyundai: ['Elantra', 'Sonata', 'Tucson', 'Santa Fe', 'Accent', 'Azera', 'Creta', 'Kona', 'Palisade', 'i10', 'i20', 'Staria', 'Genesis'],
  Kia: ['Cerato', 'Optima', 'K5', 'Sportage', 'Sorento', 'Rio', 'Picanto', 'Carnival', 'Seltos', 'Mohave', 'Pegas', 'Telluride'],
  Nissan: ['Sunny', 'Altima', 'Patrol', 'Pathfinder', 'X-Trail', 'Navara', 'Maxima', 'Kicks', 'Sentra', 'Armada', 'Juke'],
  Chevrolet: ['Malibu', 'Cruze', 'Tahoe', 'Suburban', 'Silverado', 'Captiva', 'Spark', 'Impala', 'Camaro', 'Trax', 'Equinox', 'Traverse', 'Optra', 'Aveo', 'Groove'],
  GMC: ['Yukon', 'Sierra', 'Acadia', 'Terrain', 'Savana'],
  Ford: ['Explorer', 'Expedition', 'F-150', 'Edge', 'Escape', 'Fusion', 'Focus', 'Mustang', 'Ranger', 'Taurus', 'Territory'],
  Lexus: ['LX', 'GX', 'RX', 'ES', 'IS', 'LS', 'NX', 'UX'],
  'Mercedes-Benz': ['A-Class', 'C-Class', 'E-Class', 'S-Class', 'CLA', 'GLA', 'GLC', 'GLE', 'GLS', 'G-Class', 'Vito', 'Sprinter'],
  BMW: ['1 Series', '3 Series', '5 Series', '7 Series', 'X1', 'X3', 'X5', 'X6', 'X7'],
  Mitsubishi: ['Pajero', 'Lancer', 'L200', 'Outlander', 'ASX', 'Attrage', 'Eclipse Cross'],
  Honda: ['Accord', 'Civic', 'CR-V', 'Pilot', 'City', 'HR-V', 'Odyssey'],
  'Land Rover': ['Range Rover', 'Range Rover Sport', 'Range Rover Velar', 'Range Rover Evoque', 'Defender', 'Discovery'],
  Jeep: ['Grand Cherokee', 'Wrangler', 'Cherokee', 'Compass', 'Renegade'],
  Dodge: ['Charger', 'Challenger', 'Durango', 'Ram'],
  Chrysler: ['300C', 'Pacifica'],
  Cadillac: ['Escalade', 'CT5', 'XT5'],
  Infiniti: ['QX80', 'QX60', 'Q50'],
  Mazda: ['Mazda 3', 'Mazda 6', 'CX-3', 'CX-5', 'CX-9'],
  Volkswagen: ['Passat', 'Golf', 'Jetta', 'Touareg', 'Tiguan', 'Teramont'],
  Audi: ['A4', 'A6', 'A8', 'Q5', 'Q7', 'Q8'],
  Porsche: ['Cayenne', 'Macan', 'Panamera'],
  Peugeot: ['206', '301', '308', '508', '2008', '3008', '5008'],
  Renault: ['Logan', 'Symbol', 'Duster', 'Megane', 'Koleos'],
  Suzuki: ['Swift', 'Vitara', 'Jimny', 'Ciaz', 'Dzire'],
  Isuzu: ['D-Max', 'MU-X'],
  Changan: ['CS35', 'CS55', 'CS75', 'CS85', 'CS95', 'Alsvin', 'Eado', 'UNI-K'],
  Chery: ['Tiggo 2', 'Tiggo 4', 'Tiggo 7', 'Tiggo 8', 'Arrizo 5', 'Arrizo 6'],
  Geely: ['Coolray', 'Emgrand', 'Okavango', 'Tugella', 'Monjaro'],
  Haval: ['H6', 'H9', 'Jolion', 'Dargo'],
  MG: ['MG3', 'MG5', 'MG6', 'ZS', 'HS', 'RX5', 'RX8'],
  JAC: ['S3', 'S4', 'J7', 'T8'],
  BYD: ['F3', 'Song', 'Tang', 'Han', 'Atto 3', 'Seal'],
  Tesla: ['Model 3', 'Model Y', 'Model S', 'Model X'],
  Opel: ['Astra', 'Corsa', 'Insignia', 'Grandland'],
  Skoda: ['Octavia', 'Superb', 'Kodiaq', 'Kamiq'],
  Daihatsu: ['Terios', 'Sirion'],
  Subaru: ['Forester', 'Outback', 'Impreza', 'XV'],
};

function pickLang(map, lang) { return map[lang] || map.tr; }

module.exports = { NAMES, FINANCE_CATEGORIES, PRODUCT_CATEGORIES, VEHICLES, pickLang };
