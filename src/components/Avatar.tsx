const PRESETS: [string, string][] = [
  ["#5e5ce6", "#0a84ff"],
  ["#ff375f", "#ff9f0a"],
  ["#30d158", "#64d2ff"],
  ["#bf5af2", "#ff375f"],
  ["#ffd60a", "#ff9f0a"],
  ["#64d2ff", "#5e5ce6"],
];

export const PRESET_IDS = PRESETS.map((_, i) => `preset:${i}`);

interface Props {
  avatar: string;
  username?: string;
  size?: number;
}

export default function Avatar({ avatar, username = "", size = 40 }: Props) {
  const style = { width: size, height: size, fontSize: size * 0.42 };
  if (avatar.startsWith("data:")) {
    return (
      <div className="avatar" style={style}>
        <img src={avatar} alt="avatar" />
      </div>
    );
  }
  const idx = avatar.startsWith("preset:") ? Number(avatar.slice(7)) % PRESETS.length : 0;
  const [from, to] = PRESETS[idx] ?? PRESETS[0];
  const initial = username.trim().charAt(0).toUpperCase() || "◈";
  return (
    <div
      className="avatar"
      style={{ ...style, background: `linear-gradient(135deg, ${from}, ${to})` }}
    >
      {initial}
    </div>
  );
}
