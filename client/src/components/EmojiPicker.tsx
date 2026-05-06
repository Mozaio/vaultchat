import { useEffect, useMemo, useRef, useState } from "react";
import { IconSearch, IconX } from "./Icons";

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

export function EmojiPicker({
  onPick,
  onClose,
  align = "left",
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  align?: "left" | "right";
}) {
  const [active, setActive] = useState<string>(CATEGORIES[0].id);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const wrapRef = useRef<HTMLDivElement>(null);

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
      if (active === "recent") return recent;
      return CATEGORIES.find((c) => c.id === active)?.emojis ?? [];
    }
    // simple search across category labels for keywords
    const all = new Set<string>();
    for (const c of CATEGORIES) {
      if (c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) {
        for (const e of c.emojis) all.add(e);
      }
    }
    return Array.from(all);
  }, [query, active, recent]);

  const handlePick = (emoji: string) => {
    onPick(emoji);
    pushRecentEmoji(emoji);
    setRecent(loadRecent());
  };

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

      <div className="emoji-picker-grid" role="grid">
        {visible.length === 0 ? (
          <div className="emoji-picker-empty">Keine Treffer.</div>
        ) : (
          visible.map((e, i) => (
            <button
              key={`${e}-${i}`}
              type="button"
              className="emoji-picker-cell"
              onClick={() => handlePick(e)}
              aria-label={e}
            >
              {e}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
