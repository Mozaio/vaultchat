/**
 * Minimal, dependency-free i18n.
 *
 * Same spirit as themeStore/autoLock: a module-level current locale persisted
 * in localStorage, a change event, and a React hook (useSyncExternalStore) so
 * components re-render when the language switches. `t(key)` looks up the
 * current locale, falls back to English, then to the key itself.
 *
 * Adding a language = add its code to Locale + LOCALES; missing per-key
 * translations fall back to English automatically (Dict is partial). Adding a
 * string = add one key to DICT (English is the canonical fallback).
 */
import { useSyncExternalStore } from "react";

export type Locale =
  | "en"
  | "de"
  | "tr"
  | "es"
  | "fr"
  | "pt"
  | "ru"
  | "ar"
  | "zh"
  | "hi";

export const LOCALES: { code: Locale; label: string; rtl?: boolean }[] = [
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "tr", label: "Türkçe" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "pt", label: "Português" },
  { code: "ru", label: "Русский" },
  { code: "ar", label: "العربية", rtl: true },
  { code: "zh", label: "中文" },
  { code: "hi", label: "हिन्दी" },
];

type Dict = Partial<Record<Locale, string>>;

/** key -> per-locale string. English is the canonical fallback; any missing
 *  locale entry falls back to English, then to the key. */
const DICT: Record<string, Dict> = {
  "lang.label": {
    en: "Language", de: "Sprache", tr: "Dil", es: "Idioma", fr: "Langue",
    pt: "Idioma", ru: "Язык", ar: "اللغة", zh: "语言", hi: "भाषा",
  },
  "brand.tagline": {
    en: "End-to-end encrypted. No server reads along.",
    de: "Ende-zu-Ende verschlüsselt. Kein Server liest mit.",
    tr: "Uçtan uca şifreli. Sunucu okumaz.",
    es: "Cifrado de extremo a extremo. Ningún servidor lee.",
    fr: "Chiffré de bout en bout. Aucun serveur ne lit.",
    pt: "Criptografado de ponta a ponta. Nenhum servidor lê.",
    ru: "Сквозное шифрование. Сервер ничего не читает.",
    ar: "مشفّر من طرف إلى طرف. لا يقرأ أي خادم.",
    zh: "端到端加密。服务器无法读取。",
    hi: "एंड-टू-एंड एन्क्रिप्टेड। कोई सर्वर नहीं पढ़ता।",
  },
  "auth.welcomeBack": {
    en: "Welcome back", de: "Willkommen zurück", tr: "Tekrar hoş geldin",
    es: "Bienvenido de nuevo", fr: "Bon retour", pt: "Bem-vindo de volta",
    ru: "С возвращением", ar: "مرحبًا بعودتك", zh: "欢迎回来",
    hi: "वापसी पर स्वागत है",
  },
  "auth.otherAccount": {
    en: "Other account", de: "Anderes Konto", tr: "Başka hesap",
    es: "Otra cuenta", fr: "Autre compte", pt: "Outra conta",
    ru: "Другой аккаунт", ar: "حساب آخر", zh: "其他账户", hi: "अन्य खाता",
  },
  "auth.importBackup": {
    en: "Import backup", de: "Backup importieren", tr: "Yedeği içe aktar",
    es: "Importar copia de seguridad", fr: "Importer la sauvegarde",
    pt: "Importar backup", ru: "Импорт резервной копии",
    ar: "استيراد نسخة احتياطية", zh: "导入备份", hi: "बैकअप आयात करें",
  },
  "auth.createAccount": {
    en: "Create account", de: "Konto erstellen", tr: "Hesap oluştur",
    es: "Crear cuenta", fr: "Créer un compte", pt: "Criar conta",
    ru: "Создать аккаунт", ar: "إنشاء حساب", zh: "创建账户", hi: "खाता बनाएं",
  },
  "auth.signIn": {
    en: "Sign in", de: "Anmelden", tr: "Giriş yap", es: "Iniciar sesión",
    fr: "Se connecter", pt: "Entrar", ru: "Войти", ar: "تسجيل الدخول",
    zh: "登录", hi: "साइन इन करें",
  },
  "auth.register": {
    en: "Register", de: "Registrieren", tr: "Kayıt ol", es: "Registrarse",
    fr: "S'inscrire", pt: "Registrar", ru: "Регистрация", ar: "تسجيل",
    zh: "注册", hi: "रजिस्टर करें",
  },
  "auth.unlock": {
    en: "Unlock", de: "Entsperren", tr: "Kilidi aç", es: "Desbloquear",
    fr: "Déverrouiller", pt: "Desbloquear", ru: "Разблокировать", ar: "فتح",
    zh: "解锁", hi: "अनलॉक करें",
  },
  "auth.unlocking": {
    en: "Unlocking …", de: "Entsperre …", tr: "Kilit açılıyor …",
    es: "Desbloqueando …", fr: "Déverrouillage …", pt: "Desbloqueando …",
    ru: "Разблокировка …", ar: "جارٍ الفتح …", zh: "正在解锁 …",
    hi: "अनलॉक हो रहा है …",
  },
  "auth.sub.unlock": {
    en: "Unlock your local keys with your password.",
    de: "Lokale Schlüssel mit deinem Passwort entsperren.",
    tr: "Yerel anahtarlarını parolanla aç.",
    es: "Desbloquea tus claves locales con tu contraseña.",
    fr: "Déverrouillez vos clés locales avec votre mot de passe.",
    pt: "Desbloqueie suas chaves locais com sua senha.",
    ru: "Разблокируйте локальные ключи паролем.",
    ar: "افتح مفاتيحك المحلية بكلمة المرور.",
    zh: "用密码解锁本地密钥。",
    hi: "अपने पासवर्ड से स्थानीय कुंजियाँ अनलॉक करें।",
  },
  "auth.sub.other": {
    en: "Sign in with a different account on this device.",
    de: "Mit anderem Konto auf diesem Gerät einloggen.",
    tr: "Bu cihazda başka bir hesapla giriş yap.",
    es: "Inicia sesión con otra cuenta en este dispositivo.",
    fr: "Connectez-vous avec un autre compte sur cet appareil.",
    pt: "Entre com outra conta neste dispositivo.",
    ru: "Войдите под другим аккаунтом на этом устройстве.",
    ar: "سجّل الدخول بحساب آخر على هذا الجهاز.",
    zh: "在此设备上使用其他账户登录。",
    hi: "इस डिवाइस पर किसी अन्य खाते से साइन इन करें।",
  },
  "auth.sub.register": {
    en: "Choose a username and a strong password. No email required.",
    de: "Wähle einen Benutzernamen und ein starkes Passwort. Keine E-Mail nötig.",
    tr: "Bir kullanıcı adı ve güçlü bir parola seç. E-posta gerekmez.",
    es: "Elige un nombre de usuario y una contraseña segura. Sin correo electrónico.",
    fr: "Choisissez un nom d'utilisateur et un mot de passe fort. Aucun e-mail requis.",
    pt: "Escolha um nome de usuário e uma senha forte. Sem e-mail.",
    ru: "Выберите имя пользователя и надёжный пароль. Email не нужен.",
    ar: "اختر اسم مستخدم وكلمة مرور قوية. لا حاجة للبريد الإلكتروني.",
    zh: "选择用户名和强密码。无需电子邮件。",
    hi: "एक उपयोगकर्ता नाम और मजबूत पासवर्ड चुनें। ईमेल की आवश्यकता नहीं।",
  },
  "auth.sub.import": {
    en: "Import an encrypted backup to keep chatting on this device.",
    de: "Importiere ein verschlüsseltes Backup, um auf diesem Gerät weiter zu chatten.",
    tr: "Bu cihazda sohbete devam etmek için şifreli bir yedek içe aktar.",
    es: "Importa una copia cifrada para seguir chateando en este dispositivo.",
    fr: "Importez une sauvegarde chiffrée pour continuer à discuter sur cet appareil.",
    pt: "Importe um backup criptografado para continuar conversando neste dispositivo.",
    ru: "Импортируйте зашифрованную резервную копию, чтобы продолжить общение на этом устройстве.",
    ar: "استورد نسخة احتياطية مشفّرة لمواصلة المحادثة على هذا الجهاز.",
    zh: "导入加密备份以在此设备上继续聊天。",
    hi: "इस डिवाइस पर चैट जारी रखने के लिए एन्क्रिप्टेड बैकअप आयात करें।",
  },
  "auth.sub.login": {
    en: "Sign in with your username and password.",
    de: "Mit Benutzername und Passwort einloggen.",
    tr: "Kullanıcı adın ve parolanla giriş yap.",
    es: "Inicia sesión con tu nombre de usuario y contraseña.",
    fr: "Connectez-vous avec votre nom d'utilisateur et mot de passe.",
    pt: "Entre com seu nome de usuário e senha.",
    ru: "Войдите, указав имя пользователя и пароль.",
    ar: "سجّل الدخول باسم المستخدم وكلمة المرور.",
    zh: "使用用户名和密码登录。",
    hi: "अपने उपयोगकर्ता नाम और पासवर्ड से साइन इन करें।",
  },
  "auth.passwordLocalLabel": {
    en: "Password for local keys", de: "Passwort für lokale Schlüssel",
    tr: "Yerel anahtarlar için parola",
    es: "Contraseña para claves locales", fr: "Mot de passe des clés locales",
    pt: "Senha das chaves locais", ru: "Пароль для локальных ключей",
    ar: "كلمة مرور المفاتيح المحلية", zh: "本地密钥密码",
    hi: "स्थानीय कुंजियों का पासवर्ड",
  },
  "auth.capsLock": {
    en: "Caps Lock is on", de: "Feststelltaste ist aktiv",
    tr: "Caps Lock açık", es: "Bloq Mayús está activado",
    fr: "Verr. Maj est activé", pt: "Caps Lock está ativado",
    ru: "Включён Caps Lock", ar: "مفتاح الأحرف الكبيرة مُفعّل",
    zh: "大写锁定已开启", hi: "Caps Lock चालू है",
  },
  "auth.showPassword": {
    en: "Show password", de: "Passwort anzeigen", tr: "Parolayı göster",
    es: "Mostrar contraseña", fr: "Afficher le mot de passe",
    pt: "Mostrar senha", ru: "Показать пароль", ar: "إظهار كلمة المرور",
    zh: "显示密码", hi: "पासवर्ड दिखाएं",
  },
  "auth.hidePassword": {
    en: "Hide password", de: "Passwort verbergen", tr: "Parolayı gizle",
    es: "Ocultar contraseña", fr: "Masquer le mot de passe",
    pt: "Ocultar senha", ru: "Скрыть пароль", ar: "إخفاء كلمة المرور",
    zh: "隐藏密码", hi: "पासवर्ड छिपाएं",
  },

  // ── Chat shell / nav ──────────────────────────────────────────────
  "nav.chats": {
    en: "Chats", de: "Chats", tr: "Sohbetler", es: "Chats", fr: "Discussions",
    pt: "Conversas", ru: "Чаты", ar: "المحادثات", zh: "聊天", hi: "चैट",
  },
  "nav.settings": {
    en: "Settings", de: "Einstellungen", tr: "Ayarlar", es: "Ajustes",
    fr: "Paramètres", pt: "Configurações", ru: "Настройки", ar: "الإعدادات",
    zh: "设置", hi: "सेटिंग्स",
  },
  "nav.lock": {
    en: "Lock", de: "Sperren", tr: "Kilitle", es: "Bloquear",
    fr: "Verrouiller", pt: "Bloquear", ru: "Заблокировать", ar: "قفل",
    zh: "锁定", hi: "लॉक करें",
  },
  "nav.newChat": {
    en: "New chat", de: "Neuer Chat", tr: "Yeni sohbet", es: "Nuevo chat",
    fr: "Nouvelle discussion", pt: "Nova conversa", ru: "Новый чат",
    ar: "محادثة جديدة", zh: "新聊天", hi: "नई चैट",
  },
  "common.cancel": {
    en: "Cancel", de: "Abbrechen", tr: "İptal", es: "Cancelar", fr: "Annuler",
    pt: "Cancelar", ru: "Отмена", ar: "إلغاء", zh: "取消", hi: "रद्द करें",
  },
  "common.send": {
    en: "Send", de: "Senden", tr: "Gönder", es: "Enviar", fr: "Envoyer",
    pt: "Enviar", ru: "Отправить", ar: "إرسال", zh: "发送", hi: "भेजें",
  },
  "common.save": {
    en: "Save", de: "Speichern", tr: "Kaydet", es: "Guardar",
    fr: "Enregistrer", pt: "Salvar", ru: "Сохранить", ar: "حفظ", zh: "保存",
    hi: "सहेजें",
  },
  "common.search": {
    en: "Search", de: "Suchen", tr: "Ara", es: "Buscar", fr: "Rechercher",
    pt: "Buscar", ru: "Поиск", ar: "بحث", zh: "搜索", hi: "खोजें",
  },

  // ── Empty states ──────────────────────────────────────────────────
  "empty.welcomeTitle": {
    en: "Welcome to Umbra", de: "Willkommen bei Umbra",
    tr: "Umbra'ya hoş geldin", es: "Bienvenido a Umbra",
    fr: "Bienvenue sur Umbra", pt: "Bem-vindo ao Umbra",
    ru: "Добро пожаловать в Umbra", ar: "مرحبًا بك في Umbra",
    zh: "欢迎使用 Umbra", hi: "Umbra में आपका स्वागत है",
  },
  "empty.welcomeSubtitle": {
    en: "Pick a conversation on the left — or start a new, private chat. End-to-end encrypted, no server reads along.",
    de: "Wähle links eine Unterhaltung — oder starte ein neues, privates Gespräch. Ende-zu-Ende verschlüsselt, kein Server liest mit.",
    tr: "Soldan bir sohbet seç — ya da yeni, özel bir sohbet başlat. Uçtan uca şifreli, sunucu okumaz.",
    es: "Elige una conversación a la izquierda o inicia un chat nuevo y privado. Cifrado de extremo a extremo, ningún servidor lee.",
    fr: "Choisissez une conversation à gauche, ou démarrez une nouvelle discussion privée. Chiffré de bout en bout, aucun serveur ne lit.",
    pt: "Escolha uma conversa à esquerda ou inicie um chat novo e privado. Criptografado de ponta a ponta, nenhum servidor lê.",
    ru: "Выберите разговор слева или начните новый приватный чат. Сквозное шифрование, сервер ничего не читает.",
    ar: "اختر محادثة من اليسار — أو ابدأ محادثة خاصة جديدة. مشفّرة من طرف إلى طرف، لا يقرأ أي خادم.",
    zh: "在左侧选择一个对话，或开始新的私密聊天。端到端加密，服务器无法读取。",
    hi: "बाईं ओर कोई बातचीत चुनें — या नई, निजी चैट शुरू करें। एंड-टू-एंड एन्क्रिप्टेड, कोई सर्वर नहीं पढ़ता।",
  },

  // ── Search + composer ─────────────────────────────────────────────
  "search.placeholder": {
    en: "Search or add a contact", de: "Suchen oder Kontakt hinzufügen",
    tr: "Ara veya kişi ekle", es: "Buscar o añadir contacto",
    fr: "Rechercher ou ajouter un contact", pt: "Buscar ou adicionar contato",
    ru: "Поиск или добавить контакт", ar: "ابحث أو أضف جهة اتصال",
    zh: "搜索或添加联系人", hi: "खोजें या संपर्क जोड़ें",
  },
  "composer.toName": {
    en: "Message {name} …", de: "Nachricht an {name} …",
    tr: "{name} kişisine mesaj …", es: "Mensaje para {name} …",
    fr: "Message à {name} …", pt: "Mensagem para {name} …",
    ru: "Сообщение для {name} …", ar: "رسالة إلى {name} …",
    zh: "给 {name} 发消息 …", hi: "{name} को संदेश …",
  },
  "composer.note": {
    en: "Write a note to yourself", de: "Notiz für dich schreiben",
    tr: "Kendine bir not yaz", es: "Escribe una nota para ti",
    fr: "Écrivez une note pour vous", pt: "Escreva uma nota para você",
    ru: "Заметка для себя", ar: "اكتب ملاحظة لنفسك",
    zh: "给自己写个备注", hi: "खुद के लिए नोट लिखें",
  },
  "composer.group": {
    en: "Group message…", de: "Gruppennachricht…", tr: "Grup mesajı…",
    es: "Mensaje de grupo…", fr: "Message de groupe…", pt: "Mensagem do grupo…",
    ru: "Сообщение группе…", ar: "رسالة جماعية…", zh: "群组消息…",
    hi: "समूह संदेश…",
  },
  "composer.viewOnce": {
    en: "View-once message…", de: "Einmal-Nachricht…",
    tr: "Tek seferlik mesaj…", es: "Mensaje de una vez…",
    fr: "Message éphémère…", pt: "Mensagem única…",
    ru: "Одноразовое сообщение…", ar: "رسالة لمرة واحدة…",
    zh: "阅后即焚消息…", hi: "एक-बार संदेश…",
  },
  "composer.recording": {
    en: "Recording …", de: "Aufnahme läuft …", tr: "Kaydediliyor …",
    es: "Grabando …", fr: "Enregistrement …", pt: "Gravando …",
    ru: "Идёт запись …", ar: "جارٍ التسجيل …", zh: "正在录音 …",
    hi: "रिकॉर्डिंग …",
  },
};

const STORAGE_KEY = "vaultchat.locale";
const EVENT = "vaultchat:localeChanged";

function isLocale(x: unknown): x is Locale {
  return typeof x === "string" && LOCALES.some((l) => l.code === x);
}

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    /* ignore */
  }
  try {
    const langs = navigator.languages ?? [navigator.language];
    for (const l of langs) {
      const code = l.slice(0, 2).toLowerCase();
      if (isLocale(code)) return code;
    }
  } catch {
    /* ignore */
  }
  return "en";
}

let current: Locale = detectLocale();

export function isRtl(loc: Locale = current): boolean {
  return LOCALES.find((l) => l.code === loc)?.rtl ?? false;
}

function applyDocLocale(loc: Locale): void {
  try {
    document.documentElement.lang = loc;
    document.documentElement.dir = isRtl(loc) ? "rtl" : "ltr";
  } catch {
    /* SSR / no document */
  }
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(loc: Locale): void {
  if (!isLocale(loc)) return;
  if (loc === current) {
    applyDocLocale(loc);
    return;
  }
  current = loc;
  try {
    localStorage.setItem(STORAGE_KEY, loc);
  } catch {
    /* ignore */
  }
  applyDocLocale(loc);
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: loc }));
  } catch {
    /* ignore */
  }
}

/** Translate a key for the current locale. Falls back current -> en -> key. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const row = DICT[key];
  let s = (row && (row[current] ?? row.en)) ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return s;
}

/** Apply dir/lang on first import so RTL is correct before React mounts. */
applyDocLocale(current);

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

/** Subscribe a component to locale changes; returns the current locale. */
export function useLocale(): Locale {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current
  );
}
