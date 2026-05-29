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
  "nav.help": {
    en: "Help & keyboard shortcuts", de: "Hilfe & Tastatur-Shortcuts",
    tr: "Yardım & klavye kısayolları", es: "Ayuda y atajos de teclado",
    fr: "Aide & raccourcis clavier", pt: "Ajuda e atalhos de teclado",
    ru: "Помощь и горячие клавиши", ar: "المساعدة واختصارات لوحة المفاتيح",
    zh: "帮助与快捷键", hi: "मदद और कीबोर्ड शॉर्टकट",
  },
  "nav.refresh": {
    en: "Refresh", de: "Aktualisieren", tr: "Yenile", es: "Actualizar",
    fr: "Actualiser", pt: "Atualizar", ru: "Обновить", ar: "تحديث",
    zh: "刷新", hi: "रिफ्रेश करें",
  },
  "nav.account": {
    en: "Account", de: "Konto", tr: "Hesap", es: "Cuenta", fr: "Compte",
    pt: "Conta", ru: "Аккаунт", ar: "الحساب", zh: "账户", hi: "खाता",
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

  // ── Common buttons (reused across menus/modals/onboarding) ────────
  "common.skip": {
    en: "Skip", de: "Überspringen", tr: "Atla", es: "Omitir", fr: "Passer",
    pt: "Pular", ru: "Пропустить", ar: "تخطّي", zh: "跳过", hi: "छोड़ें",
  },
  "common.back": {
    en: "Back", de: "Zurück", tr: "Geri", es: "Atrás", fr: "Retour",
    pt: "Voltar", ru: "Назад", ar: "رجوع", zh: "返回", hi: "वापस",
  },
  "common.next": {
    en: "Next", de: "Weiter", tr: "İleri", es: "Siguiente", fr: "Suivant",
    pt: "Próximo", ru: "Далее", ar: "التالي", zh: "下一步", hi: "आगे",
  },
  "common.done": {
    en: "Done", de: "Fertig", tr: "Bitti", es: "Listo", fr: "Terminé",
    pt: "Concluído", ru: "Готово", ar: "تم", zh: "完成", hi: "हो गया",
  },
  "common.copied": {
    en: "Copied to clipboard", de: "In Zwischenablage kopiert",
    tr: "Panoya kopyalandı", es: "Copiado al portapapeles",
    fr: "Copié dans le presse-papiers", pt: "Copiado",
    ru: "Скопировано в буфер", ar: "تم النسخ", zh: "已复制到剪贴板",
    hi: "क्लिपबोर्ड में कॉपी किया",
  },
  "common.copyFailed": {
    en: "Copy failed", de: "Kopieren fehlgeschlagen", tr: "Kopyalama başarısız",
    es: "Error al copiar", fr: "Échec de la copie", pt: "Falha ao copiar",
    ru: "Не удалось скопировать", ar: "فشل النسخ", zh: "复制失败",
    hi: "कॉपी विफल",
  },

  // ── Onboarding ────────────────────────────────────────────────────
  "ob.s1.title": {
    en: "Welcome to Umbra", de: "Willkommen bei Umbra",
    tr: "Umbra'ya hoş geldin", es: "Bienvenido a Umbra",
    fr: "Bienvenue sur Umbra", pt: "Bem-vindo ao Umbra",
    ru: "Добро пожаловать в Umbra", ar: "مرحبًا بك في Umbra",
    zh: "欢迎使用 Umbra", hi: "Umbra में आपका स्वागत है",
  },
  "ob.s1.text": {
    en: "Your chats are end-to-end encrypted. For direct messages the server sees neither the content nor the sender (sealed sender).",
    de: "Deine Chats sind Ende-zu-Ende verschlüsselt. Der Server sieht weder Inhalte noch den Absender bei Direktnachrichten (Sealed Sender).",
    tr: "Sohbetlerin uçtan uca şifrelidir. Doğrudan mesajlarda sunucu ne içeriği ne de göndereni görür (sealed sender).",
    es: "Tus chats están cifrados de extremo a extremo. En los mensajes directos el servidor no ve ni el contenido ni el remitente (sealed sender).",
    fr: "Vos discussions sont chiffrées de bout en bout. Pour les messages directs, le serveur ne voit ni le contenu ni l'expéditeur (sealed sender).",
    pt: "Seus chats são criptografados de ponta a ponta. Em mensagens diretas, o servidor não vê o conteúdo nem o remetente (sealed sender).",
    ru: "Ваши чаты зашифрованы сквозным шифрованием. В личных сообщениях сервер не видит ни содержимое, ни отправителя (sealed sender).",
    ar: "محادثاتك مشفّرة من طرف إلى طرف. في الرسائل المباشرة لا يرى الخادم المحتوى ولا المُرسِل (sealed sender).",
    zh: "你的聊天是端到端加密的。私信中服务器既看不到内容也看不到发送者（sealed sender）。",
    hi: "आपकी चैट एंड-टू-एंड एन्क्रिप्टेड हैं। डायरेक्ट मैसेज में सर्वर न सामग्री देखता है न भेजने वाले को (sealed sender)।",
  },
  "ob.s2.title": {
    en: "Don't forget your backup", de: "Backup nicht vergessen",
    tr: "Yedeği unutma", es: "No olvides tu copia de seguridad",
    fr: "N'oubliez pas votre sauvegarde", pt: "Não esqueça seu backup",
    ru: "Не забудьте о резервной копии", ar: "لا تنسَ نسختك الاحتياطية",
    zh: "别忘了备份", hi: "अपना बैकअप न भूलें",
  },
  "ob.s2.text": {
    en: "Your key lives only on this device. Without an encrypted backup you cannot access your conversations on a new phone or after data loss.",
    de: "Der Schlüssel liegt nur auf diesem Gerät. Ohne verschlüsseltes Backup gibt es auf einem neuen Handy oder nach Datenverlust keinen Zugriff auf deine Konversationen.",
    tr: "Anahtarın yalnızca bu cihazda. Şifreli bir yedek olmadan yeni bir telefonda veya veri kaybından sonra sohbetlerine erişemezsin.",
    es: "Tu clave solo está en este dispositivo. Sin una copia cifrada no podrás acceder a tus conversaciones en un teléfono nuevo o tras una pérdida de datos.",
    fr: "Votre clé n'existe que sur cet appareil. Sans sauvegarde chiffrée, vous ne pourrez pas accéder à vos conversations sur un nouveau téléphone ou après une perte de données.",
    pt: "Sua chave fica apenas neste dispositivo. Sem um backup criptografado, você não acessa suas conversas em um novo celular ou após perda de dados.",
    ru: "Ваш ключ хранится только на этом устройстве. Без зашифрованной резервной копии вы не получите доступ к перепискам на новом телефоне или после потери данных.",
    ar: "مفتاحك موجود على هذا الجهاز فقط. بدون نسخة احتياطية مشفّرة لن تتمكن من الوصول إلى محادثاتك على هاتف جديد أو بعد فقدان البيانات.",
    zh: "你的密钥只存在于此设备。没有加密备份，换新手机或数据丢失后将无法访问你的对话。",
    hi: "आपकी कुंजी केवल इसी डिवाइस पर है। एन्क्रिप्टेड बैकअप के बिना नए फ़ोन पर या डेटा खोने के बाद आप अपनी बातचीत तक नहीं पहुँच पाएँगे।",
  },
  "ob.s3.title": {
    en: "Get started", de: "Loslegen", tr: "Başla", es: "Empezar",
    fr: "Commencer", pt: "Começar", ru: "Начать", ar: "ابدأ",
    zh: "开始", hi: "शुरू करें",
  },
  "ob.s3.text": {
    en: "Add contacts via search or create a group. Tip: verify safety numbers for important contacts.",
    de: "Füge Kontakte über die Suche hinzu oder lege eine Gruppe an. Tipp: Sicherheitsnummern bei wichtigen Kontakten verifizieren.",
    tr: "Aramayla kişi ekle veya bir grup oluştur. İpucu: önemli kişiler için güvenlik numaralarını doğrula.",
    es: "Añade contactos mediante la búsqueda o crea un grupo. Consejo: verifica los números de seguridad de los contactos importantes.",
    fr: "Ajoutez des contacts via la recherche ou créez un groupe. Astuce : vérifiez les numéros de sécurité des contacts importants.",
    pt: "Adicione contatos pela busca ou crie um grupo. Dica: verifique os números de segurança dos contatos importantes.",
    ru: "Добавляйте контакты через поиск или создайте группу. Совет: проверяйте номера безопасности у важных контактов.",
    ar: "أضِف جهات اتصال عبر البحث أو أنشئ مجموعة. نصيحة: تحقّق من أرقام الأمان لجهات الاتصال المهمة.",
    zh: "通过搜索添加联系人或创建群组。提示：为重要联系人验证安全码。",
    hi: "खोज के ज़रिए संपर्क जोड़ें या समूह बनाएं। सुझाव: महत्वपूर्ण संपर्कों के सुरक्षा नंबर सत्यापित करें।",
  },
  "ob.backupNow": {
    en: "Back up now", de: "Backup jetzt", tr: "Şimdi yedekle",
    es: "Hacer copia ahora", fr: "Sauvegarder maintenant",
    pt: "Fazer backup agora", ru: "Создать копию сейчас",
    ar: "النسخ الاحتياطي الآن", zh: "立即备份", hi: "अभी बैकअप लें",
  },
  "accent.label": {
    en: "Accent color", de: "Akzentfarbe", tr: "Vurgu rengi",
    es: "Color de acento", fr: "Couleur d'accent", pt: "Cor de destaque",
    ru: "Акцентный цвет", ar: "لون التمييز", zh: "强调色",
    hi: "एक्सेंट रंग",
  },

  // ── Message actions (per-message menu, very high frequency) ───────
  "msg.reply": {
    en: "Reply", de: "Antworten", tr: "Yanıtla", es: "Responder",
    fr: "Répondre", pt: "Responder", ru: "Ответить", ar: "رد", zh: "回复",
    hi: "उत्तर दें",
  },
  "msg.replyThread": {
    en: "Reply in thread", de: "Im Thread antworten", tr: "Konuda yanıtla",
    es: "Responder en el hilo", fr: "Répondre dans le fil",
    pt: "Responder no tópico", ru: "Ответить в треде",
    ar: "الرد في الموضوع", zh: "在话题中回复", hi: "थ्रेड में उत्तर दें",
  },
  "msg.forward": {
    en: "Forward", de: "Weiterleiten", tr: "İlet", es: "Reenviar",
    fr: "Transférer", pt: "Encaminhar", ru: "Переслать", ar: "إعادة توجيه",
    zh: "转发", hi: "आगे भेजें",
  },
  "msg.star": {
    en: "Star", de: "Markieren", tr: "Yıldızla", es: "Destacar",
    fr: "Marquer", pt: "Marcar", ru: "В избранное", ar: "تمييز",
    zh: "标记", hi: "तारांकित करें",
  },
  "msg.unstar": {
    en: "Unstar", de: "Markierung entfernen", tr: "Yıldızı kaldır",
    es: "Quitar destacado", fr: "Retirer le repère", pt: "Remover marca",
    ru: "Убрать из избранного", ar: "إلغاء التمييز", zh: "取消标记",
    hi: "तारा हटाएं",
  },
  "msg.pin": {
    en: "Pin", de: "Anpinnen", tr: "Sabitle", es: "Fijar", fr: "Épingler",
    pt: "Fixar", ru: "Закрепить", ar: "تثبيت", zh: "置顶", hi: "पिन करें",
  },
  "msg.unpin": {
    en: "Unpin", de: "Pin entfernen", tr: "Sabitlemeyi kaldır",
    es: "Quitar fijado", fr: "Détacher", pt: "Desafixar", ru: "Открепить",
    ar: "إلغاء التثبيت", zh: "取消置顶", hi: "अनपिन करें",
  },
  "msg.copy": {
    en: "Copy", de: "Kopieren", tr: "Kopyala", es: "Copiar", fr: "Copier",
    pt: "Copiar", ru: "Копировать", ar: "نسخ", zh: "复制", hi: "कॉपी करें",
  },
  "msg.edit": {
    en: "Edit", de: "Bearbeiten", tr: "Düzenle", es: "Editar", fr: "Modifier",
    pt: "Editar", ru: "Изменить", ar: "تعديل", zh: "编辑", hi: "संपादित करें",
  },
  "msg.deleteForAll": {
    en: "Delete for everyone", de: "Für alle löschen", tr: "Herkesten sil",
    es: "Eliminar para todos", fr: "Supprimer pour tous",
    pt: "Apagar para todos", ru: "Удалить у всех", ar: "حذف للجميع",
    zh: "为所有人删除", hi: "सभी के लिए हटाएं",
  },
  "msg.deleted": {
    en: "Message deleted", de: "Nachricht gelöscht", tr: "Mesaj silindi",
    es: "Mensaje eliminado", fr: "Message supprimé", pt: "Mensagem apagada",
    ru: "Сообщение удалено", ar: "تم حذف الرسالة", zh: "消息已删除",
    hi: "संदेश हटाया गया",
  },
  "msg.edited": {
    en: "edited", de: "bearbeitet", tr: "düzenlendi", es: "editado",
    fr: "modifié", pt: "editado", ru: "изменено", ar: "معدّل",
    zh: "已编辑", hi: "संपादित",
  },
  "msg.react": {
    en: "React", de: "Reagieren", tr: "Tepki ver", es: "Reaccionar",
    fr: "Réagir", pt: "Reagir", ru: "Реакция", ar: "تفاعل", zh: "回应",
    hi: "प्रतिक्रिया दें",
  },

  // ── Sidebar filter chips ──────────────────────────────────────────
  "filter.all": {
    en: "All", de: "Alle", tr: "Tümü", es: "Todos", fr: "Tous", pt: "Todos",
    ru: "Все", ar: "الكل", zh: "全部", hi: "सभी",
  },
  "filter.dms": {
    en: "DMs", de: "DMs", tr: "DM'ler", es: "MD", fr: "MP", pt: "DMs",
    ru: "ЛС", ar: "خاص", zh: "私信", hi: "DM",
  },
  "filter.groups": {
    en: "Groups", de: "Gruppen", tr: "Gruplar", es: "Grupos", fr: "Groupes",
    pt: "Grupos", ru: "Группы", ar: "المجموعات", zh: "群组", hi: "समूह",
  },
  "filter.favorites": {
    en: "Favorites", de: "Favoriten", tr: "Favoriler", es: "Favoritos",
    fr: "Favoris", pt: "Favoritos", ru: "Избранное", ar: "المفضلة",
    zh: "收藏", hi: "पसंदीदा",
  },
  "filter.unread": {
    en: "Unread", de: "Ungelesen", tr: "Okunmamış", es: "No leídos",
    fr: "Non lus", pt: "Não lidos", ru: "Непрочитанные",
    ar: "غير المقروءة", zh: "未读", hi: "अपठित",
  },
  "filter.starred": {
    en: "Starred", de: "Markiert", tr: "Yıldızlı", es: "Destacados",
    fr: "Marqués", pt: "Marcados", ru: "Помеченные", ar: "المميزة",
    zh: "已标记", hi: "तारांकित",
  },

  // ── Add contact ───────────────────────────────────────────────────
  "addc.title": {
    en: "Add contact", de: "Kontakt hinzufügen", tr: "Kişi ekle",
    es: "Añadir contacto", fr: "Ajouter un contact", pt: "Adicionar contato",
    ru: "Добавить контакт", ar: "إضافة جهة اتصال", zh: "添加联系人",
    hi: "संपर्क जोड़ें",
  },
  "addc.subtitle": {
    en: "Exact username only (privacy). No phone number needed.",
    de: "Nur exakter Username (Datenschutz). Keine Telefonnummer nötig.",
    tr: "Yalnızca tam kullanıcı adı (gizlilik). Telefon numarası gerekmez.",
    es: "Solo nombre de usuario exacto (privacidad). Sin teléfono.",
    fr: "Nom d'utilisateur exact uniquement (confidentialité). Aucun numéro requis.",
    pt: "Apenas nome de usuário exato (privacidade). Sem telefone.",
    ru: "Только точное имя пользователя (приватность). Телефон не нужен.",
    ar: "اسم المستخدم الدقيق فقط (الخصوصية). لا حاجة لرقم هاتف.",
    zh: "仅限精确用户名（隐私）。无需电话号码。",
    hi: "केवल सटीक उपयोगकर्ता नाम (गोपनीयता)। फ़ोन नंबर की ज़रूरत नहीं।",
  },
  "addc.placeholder": {
    en: "Enter exact username…", de: "Exakten Username eingeben…",
    tr: "Tam kullanıcı adını gir…", es: "Escribe el nombre de usuario exacto…",
    fr: "Saisissez le nom d'utilisateur exact…",
    pt: "Digite o nome de usuário exato…",
    ru: "Введите точное имя пользователя…", ar: "أدخل اسم المستخدم الدقيق…",
    zh: "输入精确用户名…", hi: "सटीक उपयोगकर्ता नाम दर्ज करें…",
  },
  "addc.hint": {
    en: "Only a full, exact username matches — the directory is intentionally not searchable.",
    de: "Es wird nur der vollständige, exakte Username gefunden — das Verzeichnis ist absichtlich nicht durchsuchbar.",
    tr: "Yalnızca tam, kesin kullanıcı adı eşleşir — dizin bilinçli olarak aranamaz.",
    es: "Solo coincide un nombre de usuario completo y exacto — el directorio no es buscable a propósito.",
    fr: "Seul un nom d'utilisateur complet et exact correspond — l'annuaire n'est volontairement pas consultable.",
    pt: "Apenas um nome de usuário completo e exato corresponde — o diretório não é pesquisável de propósito.",
    ru: "Совпадает только полное точное имя — каталог намеренно нельзя просматривать.",
    ar: "يطابق فقط اسم المستخدم الكامل والدقيق — الدليل غير قابل للبحث عمدًا.",
    zh: "仅匹配完整、精确的用户名——目录有意不可搜索。",
    hi: "केवल पूरा, सटीक उपयोगकर्ता नाम मिलता है — निर्देशिका जानबूझकर खोजने योग्य नहीं है।",
  },
  "addc.emptyTitle": {
    en: "Enter the person's exact username.",
    de: "Gib den exakten Username der Person ein.",
    tr: "Kişinin tam kullanıcı adını gir.",
    es: "Escribe el nombre de usuario exacto de la persona.",
    fr: "Saisissez le nom d'utilisateur exact de la personne.",
    pt: "Digite o nome de usuário exato da pessoa.",
    ru: "Введите точное имя пользователя человека.",
    ar: "أدخل اسم المستخدم الدقيق للشخص.",
    zh: "输入此人的精确用户名。", hi: "व्यक्ति का सटीक उपयोगकर्ता नाम दर्ज करें।",
  },
  "addc.emptyHint": {
    en: "You must know the name exactly — there are no suggestions.",
    de: "Du musst den Namen genau kennen — es gibt keine Vorschläge.",
    tr: "Adı tam olarak bilmelisin — öneri yoktur.",
    es: "Debes saber el nombre exacto — no hay sugerencias.",
    fr: "Vous devez connaître le nom exact — aucune suggestion.",
    pt: "Você precisa saber o nome exato — não há sugestões.",
    ru: "Нужно знать имя точно — подсказок нет.",
    ar: "يجب أن تعرف الاسم بالضبط — لا توجد اقتراحات.",
    zh: "你必须准确知道名字——没有建议。",
    hi: "आपको नाम बिल्कुल पता होना चाहिए — कोई सुझाव नहीं।",
  },
  "addc.noResultTitle": {
    en: "No user with exactly this username.",
    de: "Kein Nutzer mit genau diesem Username.",
    tr: "Tam olarak bu kullanıcı adına sahip kullanıcı yok.",
    es: "Ningún usuario con exactamente este nombre.",
    fr: "Aucun utilisateur avec exactement ce nom.",
    pt: "Nenhum usuário com exatamente este nome.",
    ru: "Нет пользователя с точно таким именем.",
    ar: "لا يوجد مستخدم بهذا الاسم بالضبط.",
    zh: "没有完全匹配此用户名的用户。",
    hi: "बिल्कुल इस उपयोगकर्ता नाम वाला कोई उपयोगकर्ता नहीं।",
  },
  "addc.noResultHint": {
    en: "Typo? The username must match exactly.",
    de: "Tippfehler? Der Username muss exakt übereinstimmen.",
    tr: "Yazım hatası mı? Kullanıcı adı tam eşleşmeli.",
    es: "¿Error de escritura? El nombre debe coincidir exactamente.",
    fr: "Faute de frappe ? Le nom doit correspondre exactement.",
    pt: "Erro de digitação? O nome deve coincidir exatamente.",
    ru: "Опечатка? Имя должно совпадать точно.",
    ar: "خطأ إملائي؟ يجب أن يتطابق الاسم تمامًا.",
    zh: "拼写错误？用户名必须完全匹配。",
    hi: "टाइपो? उपयोगकर्ता नाम बिल्कुल मेल खाना चाहिए।",
  },
  "addc.startChat": {
    en: "Add contact and start chatting",
    de: "Kontakt hinzufügen und Chat starten",
    tr: "Kişiyi ekle ve sohbete başla",
    es: "Añadir contacto y empezar a chatear",
    fr: "Ajouter le contact et discuter",
    pt: "Adicionar contato e começar a conversar",
    ru: "Добавить контакт и начать чат",
    ar: "أضف جهة الاتصال وابدأ المحادثة",
    zh: "添加联系人并开始聊天", hi: "संपर्क जोड़ें और चैट शुरू करें",
  },
  "addc.footer": {
    en: "Contacts are chosen locally. The server never sees your private messages.",
    de: "Kontakte werden lokal ausgewählt. Der Server sieht keine privaten Nachrichten.",
    tr: "Kişiler yerel olarak seçilir. Sunucu özel mesajlarını görmez.",
    es: "Los contactos se eligen localmente. El servidor no ve tus mensajes privados.",
    fr: "Les contacts sont choisis localement. Le serveur ne voit pas vos messages privés.",
    pt: "Os contatos são escolhidos localmente. O servidor não vê suas mensagens privadas.",
    ru: "Контакты выбираются локально. Сервер не видит ваши личные сообщения.",
    ar: "تُختار جهات الاتصال محليًا. لا يرى الخادم رسائلك الخاصة.",
    zh: "联系人在本地选择。服务器永远看不到你的私信。",
    hi: "संपर्क स्थानीय रूप से चुने जाते हैं। सर्वर आपके निजी संदेश कभी नहीं देखता।",
  },
  "addc.searchFailed": {
    en: "Search failed. Please try again.",
    de: "Suche fehlgeschlagen. Bitte erneut versuchen.",
    tr: "Arama başarısız. Lütfen tekrar dene.",
    es: "La búsqueda falló. Inténtalo de nuevo.",
    fr: "La recherche a échoué. Veuillez réessayer.",
    pt: "A busca falhou. Tente novamente.",
    ru: "Поиск не удался. Попробуйте ещё раз.",
    ar: "فشل البحث. حاول مرة أخرى.",
    zh: "搜索失败。请重试。", hi: "खोज विफल। कृपया पुनः प्रयास करें।",
  },

  // ── Settings tabs ─────────────────────────────────────────────────
  "settings.tab.general": {
    en: "General", de: "Allgemein", tr: "Genel", es: "General", fr: "Général",
    pt: "Geral", ru: "Общие", ar: "عام", zh: "常规", hi: "सामान्य",
  },
  "settings.tab.privacy": {
    en: "Privacy", de: "Datenschutz", tr: "Gizlilik", es: "Privacidad",
    fr: "Confidentialité", pt: "Privacidade", ru: "Приватность",
    ar: "الخصوصية", zh: "隐私", hi: "गोपनीयता",
  },
  "settings.tab.security": {
    en: "Security", de: "Sicherheit", tr: "Güvenlik", es: "Seguridad",
    fr: "Sécurité", pt: "Segurança", ru: "Безопасность", ar: "الأمان",
    zh: "安全", hi: "सुरक्षा",
  },
  "settings.tab.emojis": {
    en: "Emojis", de: "Emojis", tr: "Emojiler", es: "Emojis", fr: "Emojis",
    pt: "Emojis", ru: "Эмодзи", ar: "الرموز", zh: "表情", hi: "इमोजी",
  },
  "settings.tab.plan": {
    en: "Plan & billing", de: "Plan & Abo", tr: "Plan & Abonelik",
    es: "Plan y suscripción", fr: "Forfait & abonnement",
    pt: "Plano e assinatura", ru: "Тариф и подписка", ar: "الخطة والاشتراك",
    zh: "套餐与订阅", hi: "प्लान और बिलिंग",
  },
  "settings.tab.about": {
    en: "About", de: "Über", tr: "Hakkında", es: "Acerca de", fr: "À propos",
    pt: "Sobre", ru: "О приложении", ar: "حول", zh: "关于", hi: "परिचय",
  },

  // ── Info / details panel ──────────────────────────────────────────
  "info.online": {
    en: "Online", de: "Online", tr: "Çevrimiçi", es: "En línea", fr: "En ligne",
    pt: "Online", ru: "В сети", ar: "متصل", zh: "在线", hi: "ऑनलाइन",
  },
  "info.members": {
    en: "{n} members", de: "{n} Mitglieder", tr: "{n} üye", es: "{n} miembros",
    fr: "{n} membres", pt: "{n} membros", ru: "{n} участников",
    ar: "{n} أعضاء", zh: "{n} 名成员", hi: "{n} सदस्य",
  },
  "info.favorite": {
    en: "Favorite", de: "Favorit", tr: "Favori", es: "Favorito", fr: "Favori",
    pt: "Favorito", ru: "Избранное", ar: "مفضّل", zh: "收藏", hi: "पसंदीदा",
  },
  "info.favorited": {
    en: "Favorited", de: "Favorisiert", tr: "Favorilendi", es: "Destacado",
    fr: "Favori ✓", pt: "Favoritado", ru: "В избранном", ar: "مُفضّل",
    zh: "已收藏", hi: "पसंदीदा ✓",
  },
  "info.notifications": {
    en: "Notifications", de: "Benachrichtigungen", tr: "Bildirimler",
    es: "Notificaciones", fr: "Notifications", pt: "Notificações",
    ru: "Уведомления", ar: "الإشعارات", zh: "通知", hi: "सूचनाएं",
  },
  "info.muted": {
    en: "Muted", de: "Stumm", tr: "Sessiz", es: "Silenciado", fr: "Muet",
    pt: "Silenciado", ru: "Без звука", ar: "كتم", zh: "已静音", hi: "म्यूट",
  },
  "info.block": {
    en: "Block", de: "Blockieren", tr: "Engelle", es: "Bloquear",
    fr: "Bloquer", pt: "Bloquear", ru: "Заблокировать", ar: "حظر",
    zh: "屏蔽", hi: "ब्लॉक करें",
  },
  "info.blocked": {
    en: "Blocked", de: "Blockiert", tr: "Engellendi", es: "Bloqueado",
    fr: "Bloqué", pt: "Bloqueado", ru: "Заблокирован", ar: "محظور",
    zh: "已屏蔽", hi: "ब्लॉक किया",
  },
  "info.userInfo": {
    en: "User info", de: "Benutzerinfo", tr: "Kullanıcı bilgisi",
    es: "Info de usuario", fr: "Infos utilisateur", pt: "Info do usuário",
    ru: "О пользователе", ar: "معلومات المستخدم", zh: "用户信息",
    hi: "उपयोगकर्ता जानकारी",
  },
  "info.security": {
    en: "Security", de: "Sicherheit", tr: "Güvenlik", es: "Seguridad",
    fr: "Sécurité", pt: "Segurança", ru: "Безопасность", ar: "الأمان",
    zh: "安全", hi: "सुरक्षा",
  },
  "info.e2eeBlurb": {
    en: "Messages and calls are end-to-end encrypted. The server only relays sealed data. Perfect forward secrecy is active.",
    de: "Nachrichten und Anrufe sind Ende-zu-Ende verschlüsselt. Der Server leitet nur versiegelte Daten. Perfect Forward Secrecy aktiv.",
    tr: "Mesajlar ve aramalar uçtan uca şifrelidir. Sunucu yalnızca mühürlü verileri iletir. Perfect Forward Secrecy etkin.",
    es: "Los mensajes y llamadas están cifrados de extremo a extremo. El servidor solo retransmite datos sellados. Perfect Forward Secrecy activo.",
    fr: "Les messages et appels sont chiffrés de bout en bout. Le serveur ne relaie que des données scellées. Perfect Forward Secrecy actif.",
    pt: "Mensagens e chamadas são criptografadas de ponta a ponta. O servidor só retransmite dados selados. Perfect Forward Secrecy ativo.",
    ru: "Сообщения и звонки зашифрованы сквозным шифрованием. Сервер передаёт только запечатанные данные. Perfect Forward Secrecy активен.",
    ar: "الرسائل والمكالمات مشفّرة من طرف إلى طرف. يمرّر الخادم البيانات المختومة فقط. السرية التامة للأمام مُفعّلة.",
    zh: "消息和通话端到端加密。服务器只转发密封数据。已启用完美前向保密。",
    hi: "संदेश और कॉल एंड-टू-एंड एन्क्रिप्टेड हैं। सर्वर केवल सीलबंद डेटा रिले करता है। परफेक्ट फॉरवर्ड सीक्रेसी सक्रिय है।",
  },
  "info.safetyNumber": {
    en: "Safety number", de: "Sicherheitsnummer", tr: "Güvenlik numarası",
    es: "Número de seguridad", fr: "Numéro de sécurité",
    pt: "Número de segurança", ru: "Код безопасности", ar: "رقم الأمان",
    zh: "安全码", hi: "सुरक्षा संख्या",
  },
  "info.verify": {
    en: "Verify", de: "Verifizieren", tr: "Doğrula", es: "Verificar",
    fr: "Vérifier", pt: "Verificar", ru: "Проверить", ar: "تحقّق",
    zh: "验证", hi: "सत्यापित करें",
  },
  "info.sharedMedia": {
    en: "Shared media", de: "Geteilte Inhalte", tr: "Paylaşılan içerik",
    es: "Contenido compartido", fr: "Contenu partagé", pt: "Conteúdo compartilhado",
    ru: "Общие файлы", ar: "الوسائط المشتركة", zh: "共享内容",
    hi: "साझा सामग्री",
  },
  "info.noShared": {
    en: "No files or voice notes in this chat yet.",
    de: "Noch keine Dateien oder Sprachnotizen in diesem Chat.",
    tr: "Bu sohbette henüz dosya veya sesli not yok.",
    es: "Aún no hay archivos ni notas de voz en este chat.",
    fr: "Pas encore de fichiers ni de notes vocales dans ce chat.",
    pt: "Ainda não há arquivos ou notas de voz neste chat.",
    ru: "В этом чате пока нет файлов или голосовых заметок.",
    ar: "لا توجد ملفات أو ملاحظات صوتية في هذه المحادثة بعد.",
    zh: "此聊天中还没有文件或语音备注。",
    hi: "इस चैट में अभी कोई फ़ाइल या वॉइस नोट नहीं है।",
  },
  "info.clearChat": {
    en: "Clear chat history", de: "Chat-Verlauf leeren",
    tr: "Sohbet geçmişini temizle", es: "Borrar historial del chat",
    fr: "Effacer l'historique", pt: "Limpar histórico do chat",
    ru: "Очистить историю чата", ar: "مسح سجل المحادثة",
    zh: "清除聊天记录", hi: "चैट इतिहास साफ़ करें",
  },
  "info.localOnly": {
    en: "History stays local, encrypted (IndexedDB).",
    de: "Verlauf nur lokal, verschlüsselt (IndexedDB).",
    tr: "Geçmiş yalnızca yerel, şifreli (IndexedDB).",
    es: "El historial queda local, cifrado (IndexedDB).",
    fr: "L'historique reste local, chiffré (IndexedDB).",
    pt: "O histórico fica local, criptografado (IndexedDB).",
    ru: "История хранится локально, зашифрована (IndexedDB).",
    ar: "يبقى السجل محليًا ومشفّرًا (IndexedDB).",
    zh: "历史记录仅本地保存，已加密 (IndexedDB)。",
    hi: "इतिहास केवल स्थानीय, एन्क्रिप्टेड रहता है (IndexedDB)।",
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
