import { useEffect, useMemo, useRef, useState } from "react";
import { IconSearch, IconX, IconPlus, IconTrash } from "./Icons";
import {
  addCustomEmojiFromFile,
  loadCustomEmojis,
  removeCustomEmoji,
  type CustomEmoji,
} from "../lib/customEmojis";

type Category = {
  id: string;
  label: string;
  icon: string;
  emojis: string[];
};

const CATEGORIES: Category[] = [
  {
    id: "smileys",
    label: "Smileys",
    icon: "😀",
    emojis: [
      "😀","😁","😂","🤣","😃","😄","😅","😆","😉","😊",
      "😋","😎","😍","😘","🥰","😗","😙","🙂","🤗","🤩",
      "🤔","🤨","😐","😑","😶","🙄","😏","😣","😥","😮",
      "🤐","😯","😪","😫","😴","😌","😛","😜","😝","🤤",
      "😒","😓","😔","😕","🙃","🤑","😲","☹️","🙁","😖",
      "😞","😟","😤","😢","😭","😦","😧","😨","😩","🤯",
      "😬","😰","😱","🥵","🥶","😳","🤪","😵","🥴","😡",
      "😠","🤬","😷","🤒","🤕","🤢","🤮","🥱","🤧","😇",
    ],
  },
  {
    id: "people",
    label: "Personen",
    icon: "👋",
    emojis: [
      "👋","🤚","🖐️","✋","🖖","👌","🤌","🤏","✌️","🤞",
      "🤟","🤘","🤙","👈","👉","👆","🖕","👇","☝️","👍",
      "👎","✊","👊","🤛","🤜","👏","🙌","👐","🤲","🤝",
      "🙏","✍️","💪","🦾","🦿","🦵","🦶","👀","👁️","👅",
      "👄","💋","🧠","🫀","🫁","🦷","🦴","💔","❤️","🧡",
      "💛","💚","💙","💜","🤎","🖤","🤍","💖","💗","💓",
      "💞","💕","💟","💌","💘","💝",
    ],
  },
  {
    id: "animals",
    label: "Tiere & Natur",
    icon: "🐶",
    emojis: [
      "🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯",
      "🦁","🐮","🐷","🐽","🐸","🐵","🙈","🙉","🙊","🐒",
      "🐔","🐧","🐦","🐤","🦆","🦅","🦉","🦇","🐺","🐗",
      "🐴","🦄","🐝","🐛","🦋","🐌","🐞","🐜","🦟","🕷️",
      "🦂","🐢","🐍","🦎","🦖","🦕","🐙","🦑","🦐","🦀",
      "🐡","🐠","🐟","🐬","🐳","🐋","🦈","🐊","🐅","🐆",
      "🦓","🦍","🦧","🐘","🦛","🦏","🐪","🐫","🦒","🦘",
      "🐃","🐂","🐄","🐎","🐖","🐏","🐑","🐐","🐕","🐩",
      "🌵","🌲","🌳","🌴","🌱","🌿","☘️","🍀","🎍","🎋",
      "🍃","🍂","🍁","🍄","🌾","💐","🌷","🌹","🥀","🌺",
      "🌸","🌼","🌻","🌞","🌝","🌚","🌛","🌜","🌙","⭐",
      "🌟","💫","✨","☁️","🌥️","⛅","🌦️","🌧️","⛈️","🌩️",
      "🌪️","🌈","☀️","🌤️","🔥","💥","❄️","☃️","⛄","🌊",
    ],
  },
  {
    id: "food",
    label: "Essen",
    icon: "🍔",
    emojis: [
      "🍏","🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐",
      "🍈","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🍆","🥑",
      "🥦","🥬","🥒","🌶️","🫑","🌽","🥕","🧄","🧅","🥔",
      "🍠","🥐","🥯","🍞","🥖","🥨","🧀","🥚","🍳","🧈",
      "🥞","🧇","🥓","🥩","🍗","🍖","🌭","🍔","🍟","🍕",
      "🥪","🥙","🧆","🌮","🌯","🥗","🥘","🫕","🥫","🍝",
      "🍜","🍲","🍛","🍣","🍱","🥟","🦪","🍤","🍙","🍚",
      "🍘","🍥","🥠","🥮","🍢","🍡","🍧","🍨","🍦","🥧",
      "🧁","🍰","🎂","🍮","🍭","🍬","🍫","🍿","🍩","🍪",
      "🌰","🥜","🍯","🥛","🍼","🫖","☕","🍵","🍶","🍾",
      "🍷","🍸","🍹","🍺","🍻","🥂","🥃","🥤","🧃","🧉",
      "🧊",
    ],
  },
  {
    id: "activities",
    label: "Aktivitäten",
    icon: "⚽",
    emojis: [
      "⚽","🏀","🏈","⚾","🥎","🎾","🏐","🏉","🥏","🎱",
      "🪀","🏓","🏸","🏒","🏑","🥍","🏏","🪃","🥅","⛳",
      "🪁","🏹","🎣","🤿","🥊","🥋","🎽","🛹","🛼","🛷",
      "⛸️","🥌","🎿","⛷️","🏂","🪂","🏋️","🤼","🤸","⛹️",
      "🤺","🤾","🏌️","🏇","🧘","🏄","🏊","🤽","🚣","🧗",
      "🚵","🚴","🏆","🥇","🥈","🥉","🏅","🎖️","🏵️","🎗️",
      "🎫","🎟️","🎪","🤹","🎭","🩰","🎨","🎬","🎤","🎧",
      "🎼","🎹","🥁","🎷","🎺","🎸","🪕","🎻","🎲","♟️",
      "🎯","🎳","🎮","🎰","🧩",
    ],
  },
  {
    id: "objects",
    label: "Objekte",
    icon: "💡",
    emojis: [
      "⌚","📱","📲","💻","⌨️","🖥️","🖨️","🖱️","🖲️","🕹️",
      "🗜️","💽","💾","💿","📀","📼","📷","📸","📹","🎥",
      "📽️","🎞️","📞","☎️","📟","📠","📺","📻","🎙️","🎚️",
      "🎛️","🧭","⏱️","⏲️","⏰","🕰️","⌛","⏳","📡","🔋",
      "🔌","💡","🔦","🕯️","🪔","🧯","🛢️","💸","💵","💴",
      "💶","💷","💰","💳","💎","⚖️","🪜","🧰","🔧","🔨",
      "⚒️","🛠️","⛏️","🔩","⚙️","🪤","🧱","⛓️","🧲","🔫",
      "💣","🧨","🪓","🔪","🗡️","⚔️","🛡️","🚬","⚰️","🪦",
      "⚱️","🏺","🔮","📿","🧿","💈","⚗️","🔭","🔬","🕳️",
      "🩹","🩺","💊","💉","🧬","🦠","🧫","🧪","🌡️","🧹",
      "🧺","🧻","🚽","🚰","🚿","🛁","🛀","🧼","🧽","🪣",
      "🛎️","🔑","🗝️","🚪","🪑","🛋️","🛏️","🛌","🧸","🖼️",
      "🪞","🪟","🛍️","🛒","🎁","🎈","🎏","🎀","🎊","🎉",
      "🎎","🏮","🎐","🧧","✉️","📧","📨","📩","📤","📥",
      "📦","🏷️","📪","📫","📬","📭","📮","📯","📜","📃",
      "📄","📑","🧾","📊","📈","📉","🗒️","🗓️","📆","📅",
      "🗑️","📇","🗃️","🗳️","🗄️","📋","📁","📂","🗂️","🗞️",
      "📰","📓","📔","📒","📕","📗","📘","📙","📚","📖",
      "🔖","🧷","🔗","📎","🖇️","📐","📏","🧮","📌","📍",
      "✂️","🖊️","🖋️","✒️","🖌️","🖍️","📝","✏️","🔍","🔎",
      "🔏","🔐","🔒","🔓",
    ],
  },
  {
    id: "symbols",
    label: "Symbole",
    icon: "✅",
    emojis: [
      "❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔",
      "❣️","💕","💞","💓","💗","💖","💘","💝","💟","☮️",
      "✝️","☪️","🕉️","☸️","✡️","🔯","🕎","☯️","☦️","🛐",
      "⛎","♈","♉","♊","♋","♌","♍","♎","♏","♐",
      "♑","♒","♓","🆔","⚛️","🉑","☢️","☣️","📴","📳",
      "🈶","🈚","🈸","🈺","🈷️","✴️","🆚","💮","🉐","㊙️",
      "㊗️","🈴","🈵","🈹","🈲","🅰️","🅱️","🆎","🆑","🅾️",
      "🆘","❌","⭕","🛑","⛔","📛","🚫","💯","💢","♨️",
      "🚷","🚯","🚳","🚱","🔞","📵","🚭","❗","❕","❓",
      "❔","‼️","⁉️","🔅","🔆","〽️","⚠️","🚸","🔱","⚜️",
      "🔰","♻️","✅","🈯","💹","❇️","✳️","❎","🌐","💠",
      "Ⓜ️","🌀","💤","🏧","🚾","♿","🅿️","🛗","🈳","🈂️",
      "🛂","🛃","🛄","🛅","🚹","🚺","🚼","⚧","🚻","🚮",
      "🎦","📶","🈁","🔣","ℹ️","🔤","🔡","🔠","🆖","🆗",
      "🆙","🆒","🆕","🆓","0️⃣","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣",
      "6️⃣","7️⃣","8️⃣","9️⃣","🔟","🔢","#️⃣","*️⃣","⏏️","▶️",
      "⏸️","⏯️","⏹️","⏺️","⏭️","⏮️","⏩","⏪","⏫","⏬",
      "◀️","🔼","🔽","➡️","⬅️","⬆️","⬇️","↗️","↘️","↙️",
      "↖️","↕️","↔️","↪️","↩️","⤴️","⤵️","🔀","🔁","🔂",
      "🔄","🔃","🎵","🎶","➕","➖","➗","✖️","♾️","💲",
      "💱","™️","©️","®️","✔️","☑️","🔘","🔴","🟠","🟡",
      "🟢","🔵","🟣","⚫","⚪","🟤","🔺","🔻","🔸","🔹",
      "🔶","🔷","🔳","🔲","▪️","▫️","◾","◽","◼️","◻️",
      "🟥","🟧","🟨","🟩","🟦","🟪","⬛","⬜","🟫","🔈",
      "🔇","🔉","🔊","🔔","🔕","📣","📢","👁️‍🗨️","💬","💭",
      "🗯️","♠️","♣️","♥️","♦️","🃏","🎴","🀄",
    ],
  },
  {
    id: "flags",
    label: "Flaggen",
    icon: "🏁",
    emojis: [
      "🏁","🚩","🎌","🏴","🏳️","🏳️‍🌈","🏴‍☠️",
      "🇩🇪","🇦🇹","🇨🇭","🇫🇷","🇮🇹","🇪🇸","🇵🇹","🇳🇱","🇧🇪","🇸🇪",
      "🇳🇴","🇩🇰","🇫🇮","🇬🇧","🇮🇪","🇮🇸","🇵🇱","🇨🇿","🇸🇰","🇭🇺",
      "🇷🇴","🇧🇬","🇬🇷","🇹🇷","🇷🇺","🇺🇦","🇪🇺","🇺🇸","🇨🇦","🇲🇽",
      "🇧🇷","🇦🇷","🇨🇱","🇨🇴","🇵🇪","🇯🇵","🇨🇳","🇰🇷","🇮🇳","🇵🇰",
      "🇧🇩","🇮🇩","🇹🇭","🇻🇳","🇵🇭","🇲🇾","🇸🇬","🇦🇺","🇳🇿","🇿🇦",
      "🇪🇬","🇲🇦","🇩🇿","🇹🇳","🇰🇪","🇳🇬","🇮🇱","🇸🇦","🇦🇪","🇮🇷",
      "🇮🇶","🇸🇾","🇯🇴","🇱🇧",
    ],
  },
];

const RECENT_KEY = "vaultchat.emoji.recent";
const MAX_RECENT = 24;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function saveRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    /* ignore */
  }
}

export function pushRecentEmoji(emoji: string) {
  const recent = loadRecent();
  const next = [emoji, ...recent.filter((e) => e !== emoji)];
  saveRecent(next);
}

const CUSTOM_TAB_ID = "custom";

export function EmojiPicker({
  onPick,
  onClose,
  align = "left",
  excludeCustom = false,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  align?: "left" | "right";
  /**
   * Hide the custom-emoji tab + custom hits from search.
   * Use when inserting into a plain-text composer where data-URLs
   * would render as raw strings.
   */
  excludeCustom?: boolean;
}) {
  const [active, setActive] = useState<string>(CATEGORIES[0].id);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const [customEmojis, setCustomEmojis] = useState<CustomEmoji[]>(() =>
    loadCustomEmojis()
  );
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) {
      if (active === "recent") {
        return excludeCustom
          ? recent.filter((e) => !e.startsWith("data:image/"))
          : recent;
      }
      if (active === CUSTOM_TAB_ID) return customEmojis.map((e) => e.dataUrl);
      return CATEGORIES.find((c) => c.id === active)?.emojis ?? [];
    }
    // simple search across category labels for keywords
    const all = new Set<string>();
    for (const c of CATEGORIES) {
      if (c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) {
        for (const e of c.emojis) all.add(e);
      }
    }
    if (!excludeCustom) {
      // Also surface custom emojis whose name matches the query.
      if ("custom".includes(q) || "eigene".includes(q)) {
        for (const ce of customEmojis) all.add(ce.dataUrl);
      } else {
        for (const ce of customEmojis) {
          if (ce.name.toLowerCase().includes(q)) all.add(ce.dataUrl);
        }
      }
    }
    return Array.from(all);
  }, [query, active, recent, customEmojis, excludeCustom]);

  const handlePick = (emoji: string) => {
    onPick(emoji);
    pushRecentEmoji(emoji);
    setRecent(loadRecent());
  };

  async function handleUpload(file: File) {
    setUploadError(null);
    setUploading(true);
    try {
      await addCustomEmojiFromFile(file);
      setCustomEmojis(loadCustomEmojis());
    } catch (err) {
      const code = err instanceof Error ? err.message : "emoji_failed";
      setUploadError(
        code === "emoji_invalid_type"
          ? "Bitte ein Bild (PNG, JPEG, WebP) auswählen."
          : code === "emoji_too_large"
            ? "Bild zu groß — versuche ein kleineres Motiv."
            : "Konnte den Emoji nicht hinzufügen."
      );
    } finally {
      setUploading(false);
    }
  }

  function handleRemoveCustom(id: string) {
    removeCustomEmoji(id);
    setCustomEmojis(loadCustomEmojis());
  }

  return (
    <div
      ref={wrapRef}
      className={`emoji-picker ${align === "right" ? "align-right" : "align-left"}`}
      role="dialog"
      aria-label="Emoji-Auswahl"
    >
      <div className="emoji-picker-header">
        <div className="emoji-picker-search">
          <IconSearch size={14} aria-hidden />
          <input
            type="text"
            placeholder="Suchen…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <button
          type="button"
          className="emoji-picker-close"
          onClick={onClose}
          aria-label="Schließen"
        >
          <IconX size={14} />
        </button>
      </div>

      {query.trim().length === 0 && (
        <div className="emoji-picker-tabs" role="tablist">
          {recent.length > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={active === "recent"}
              className={`emoji-picker-tab${active === "recent" ? " active" : ""}`}
              onClick={() => setActive("recent")}
              title="Zuletzt verwendet"
            >
              🕘
            </button>
          )}
          {!excludeCustom && (
            <button
              type="button"
              role="tab"
              aria-selected={active === CUSTOM_TAB_ID}
              className={`emoji-picker-tab${active === CUSTOM_TAB_ID ? " active" : ""}`}
              onClick={() => setActive(CUSTOM_TAB_ID)}
              title="Eigene Emojis"
            >
              🎨
            </button>
          )}
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={active === c.id}
              className={`emoji-picker-tab${active === c.id ? " active" : ""}`}
              onClick={() => setActive(c.id)}
              title={c.label}
            >
              {c.icon}
            </button>
          ))}
        </div>
      )}

      {active === CUSTOM_TAB_ID && query.trim().length === 0 && (
        <div
          className={`emoji-picker-custom-bar${dragOver ? " drag-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void handleUpload(file);
          }}
        >
          <button
            type="button"
            className="emoji-picker-upload"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <IconPlus size={14} />
            <span>
              {uploading
                ? "Lade …"
                : dragOver
                  ? "Bild hier ablegen"
                  : "Eigenes Emoji hinzufügen oder hierher ziehen"}
            </span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
              e.target.value = "";
            }}
          />
          {uploadError && (
            <p className="emoji-picker-upload-error">{uploadError}</p>
          )}
        </div>
      )}

      <div className="emoji-picker-grid" role="grid">
        {visible.length === 0 ? (
          <div className="emoji-picker-empty">
            {active === CUSTOM_TAB_ID
              ? "Noch keine eigenen Emojis. Klicke oben auf „Hinzufügen“."
              : "Keine Treffer."}
          </div>
        ) : (
          visible.map((e, i) => {
            const isCustom = e.startsWith("data:image/");
            const customMeta = isCustom
              ? customEmojis.find((c) => c.dataUrl === e)
              : null;
            return (
              <button
                key={`${isCustom ? customMeta?.id ?? i : e}-${i}`}
                type="button"
                className={`emoji-picker-cell${isCustom ? " custom" : ""}`}
                onClick={() => handlePick(e)}
                onContextMenu={(ev) => {
                  if (customMeta) {
                    ev.preventDefault();
                    if (window.confirm(`„${customMeta.name}“ entfernen?`)) {
                      handleRemoveCustom(customMeta.id);
                    }
                  }
                }}
                aria-label={isCustom ? customMeta?.name ?? "Custom" : e}
                title={
                  isCustom
                    ? `${customMeta?.name ?? "Custom"} (Rechtsklick: entfernen)`
                    : e
                }
              >
                {isCustom ? (
                  <span className="emoji-picker-cell-img-wrap">
                    <img src={e} alt="" loading="lazy" />
                    {customMeta && active === CUSTOM_TAB_ID && (
                      <span
                        role="button"
                        tabIndex={0}
                        className="emoji-picker-cell-remove"
                        aria-label={`„${customMeta.name}“ entfernen`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          handleRemoveCustom(customMeta.id);
                        }}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter" || ev.key === " ") {
                            ev.preventDefault();
                            ev.stopPropagation();
                            handleRemoveCustom(customMeta.id);
                          }
                        }}
                      >
                        <IconTrash size={10} />
                      </span>
                    )}
                  </span>
                ) : (
                  e
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
