import type { Skin, Theme } from "../types";
import { SKINS } from "../types";

interface Props {
  skin: Skin;
  theme: Theme;
  onSelect: (skin: Skin) => void;
  onTheme: (theme: Theme) => void;
  onClose: () => void;
}

const PREVIEWS: Record<Skin, { bg: string; color: string; label: string }> = {
  apple: {
    bg: "linear-gradient(135deg, #f5f5f7 50%, #161618 50%)",
    color: "#0a84ff",
    label: "Aa",
  },
  cyberpunk: {
    bg: "linear-gradient(135deg, #0b0714, #140d20)",
    color: "#00f0ff",
    label: "▮Aa",
  },
  xp: {
    bg: "linear-gradient(180deg, #3d95ff, #2456c9 40%, #ece9d8 40%)",
    color: "#ffffff",
    label: "Aa",
  },
};

export default function ThemeGallery({ skin, theme, onSelect, onTheme, onClose }: Props) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card">
        <h2>Appearance</h2>
        <div className="skin-grid">
          {SKINS.map((s) => (
            <button
              key={s.id}
              className={"skin-card" + (skin === s.id ? " selected" : "")}
              onClick={() => onSelect(s.id)}
            >
              <div
                className="skin-preview"
                style={{ background: PREVIEWS[s.id].bg, color: PREVIEWS[s.id].color }}
              >
                {PREVIEWS[s.id].label}
              </div>
              <div className="skin-meta">
                <div className="skin-name">{s.name}</div>
                <div className="skin-blurb">{s.blurb}</div>
              </div>
            </button>
          ))}
        </div>
        {SKINS.find((s) => s.id === skin)?.hasModes && (
          <div className="field">
            <label>Mode</label>
            <div className="segmented">
              {(["system", "light", "dark"] as Theme[]).map((t) => (
                <button key={t} className={theme === t ? "active" : ""} onClick={() => onTheme(t)}>
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
