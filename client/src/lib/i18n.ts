/**
 * Minimal, dependency-free i18n.
 *
 * Same spirit as themeStore/autoLock: a module-level current locale persisted
 * in localStorage, a change event, and a React hook (useSyncExternalStore) so
 * components re-render when the language switches. `t(key)` looks up the
 * current locale, falls back to English, then to the key itself.
 *
 * Adding a language = add its code to LOCALES + a column in DICT. Adding a
 * string = add one key to DICT (English is the canonical fallback).
 */
import { useSyncExternalStore } from "react";

export type Locale =
  | "en"
  | "de"
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
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "pt", label: "Português" },
  { code: "ru", label: "Русский" },
  { code: "ar", label: "العربية", rtl: true },
  { code: "zh", label: "中文" },
  { code: "hi", label: "हिन्दी" },
];

type Dict = Record<Locale, string>;

/** key -> per-locale string. English is the canonical fallback. */
const DICT: Record<string, Dict> = {
  "lang.label": {
    en: "Language", de: "Sprache", es: "Idioma", fr: "Langue", pt: "Idioma",
    ru: "Язык", ar: "اللغة", zh: "语言", hi: "भाषा",
  },
  "brand.tagline": {
    en: "End-to-end encrypted. No server reads along.",
    de: "Ende-zu-Ende verschlüsselt. Kein Server liest mit.",
    es: "Cifrado de extremo a extremo. Ningún servidor lee.",
    fr: "Chiffré de bout en bout. Aucun serveur ne lit.",
    pt: "Criptografado de ponta a ponta. Nenhum servidor lê.",
    ru: "Сквозное шифрование. Сервер ничего не читает.",
    ar: "مشفّر من طرف إلى طرف. لا يقرأ أي خادم.",
    zh: "端到端加密。服务器无法读取。",
    hi: "एंड-टू-एंड एन्क्रिप्टेड। कोई सर्वर नहीं पढ़ता।",
  },
  "auth.welcomeBack": {
    en: "Welcome back", de: "Willkommen zurück", es: "Bienvenido de nuevo",
    fr: "Bon retour", pt: "Bem-vindo de volta", ru: "С возвращением",
    ar: "مرحبًا بعودتك", zh: "欢迎回来", hi: "वापसी पर स्वागत है",
  },
  "auth.otherAccount": {
    en: "Other account", de: "Anderes Konto", es: "Otra cuenta",
    fr: "Autre compte", pt: "Outra conta", ru: "Другой аккаунт",
    ar: "حساب آخر", zh: "其他账户", hi: "अन्य खाता",
  },
  "auth.importBackup": {
    en: "Import backup", de: "Backup importieren", es: "Importar copia de seguridad",
    fr: "Importer la sauvegarde", pt: "Importar backup", ru: "Импорт резервной копии",
    ar: "استيراد نسخة احتياطية", zh: "导入备份", hi: "बैकअप आयात करें",
  },
  "auth.createAccount": {
    en: "Create account", de: "Konto erstellen", es: "Crear cuenta",
    fr: "Créer un compte", pt: "Criar conta", ru: "Создать аккаунт",
    ar: "إنشاء حساب", zh: "创建账户", hi: "खाता बनाएं",
  },
  "auth.signIn": {
    en: "Sign in", de: "Anmelden", es: "Iniciar sesión", fr: "Se connecter",
    pt: "Entrar", ru: "Войти", ar: "تسجيل الدخول", zh: "登录", hi: "साइन इन करें",
  },
  "auth.register": {
    en: "Register", de: "Registrieren", es: "Registrarse", fr: "S'inscrire",
    pt: "Registrar", ru: "Регистрация", ar: "تسجيل", zh: "注册", hi: "रजिस्टर करें",
  },
  "auth.unlock": {
    en: "Unlock", de: "Entsperren", es: "Desbloquear", fr: "Déverrouiller",
    pt: "Desbloquear", ru: "Разблокировать", ar: "فتح", zh: "解锁", hi: "अनलॉक करें",
  },
  "auth.unlocking": {
    en: "Unlocking …", de: "Entsperre …", es: "Desbloqueando …",
    fr: "Déverrouillage …", pt: "Desbloqueando …", ru: "Разблокировка …",
    ar: "جارٍ الفتح …", zh: "正在解锁 …", hi: "अनलॉक हो रहा है …",
  },
  "auth.sub.unlock": {
    en: "Unlock your local keys with your password.",
    de: "Lokale Schlüssel mit deinem Passwort entsperren.",
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
    es: "Contraseña para claves locales", fr: "Mot de passe des clés locales",
    pt: "Senha das chaves locais", ru: "Пароль для локальных ключей",
    ar: "كلمة مرور المفاتيح المحلية", zh: "本地密钥密码",
    hi: "स्थानीय कुंजियों का पासवर्ड",
  },
  "auth.capsLock": {
    en: "Caps Lock is on", de: "Feststelltaste ist aktiv",
    es: "Bloq Mayús está activado", fr: "Verr. Maj est activé",
    pt: "Caps Lock está ativado", ru: "Включён Caps Lock",
    ar: "مفتاح الأحرف الكبيرة مُفعّل", zh: "大写锁定已开启",
    hi: "Caps Lock चालू है",
  },
  "auth.showPassword": {
    en: "Show password", de: "Passwort anzeigen", es: "Mostrar contraseña",
    fr: "Afficher le mot de passe", pt: "Mostrar senha", ru: "Показать пароль",
    ar: "إظهار كلمة المرور", zh: "显示密码", hi: "पासवर्ड दिखाएं",
  },
  "auth.hidePassword": {
    en: "Hide password", de: "Passwort verbergen", es: "Ocultar contraseña",
    fr: "Masquer le mot de passe", pt: "Ocultar senha", ru: "Скрыть пароль",
    ar: "إخفاء كلمة المرور", zh: "隐藏密码", hi: "पासवर्ड छिपाएं",
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
  if (!isLocale(loc) || loc === current) {
    if (loc === current) applyDocLocale(loc);
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

/** Translate a key for the current locale. Falls back en -> key. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const row = DICT[key];
  let s = row ? row[current] ?? row.en : key;
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
