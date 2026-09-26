import { useState } from "react";

export const avatarNames = [
  "Orbit cat",
  "Moon ghost",
  "Astro bot",
  "Solar fox",
  "Cosmic frog",
  "Star bear",
  "Void bunny",
  "Comet owl",
  "Nova squid",
  "Lunar bat",
  "Pixel imp",
  "Cloud panda",
];
const colors = [
  "#b69aff",
  "#70e0cf",
  "#fca783",
  "#85baff",
  "#f2cf74",
  "#f29ccc",
];
export function defaultAvatar(id: string) {
  const demo = [
    "you",
    "nova",
    "ghost",
    "kira",
    "pixel",
    "ryu",
    "ash",
    "orbit",
    "zero",
  ].indexOf(id);
  return `vexa:${demo < 0 ? Number(hash(id) % 12) : demo}:${hash(id)}`;
}
function hash(s: string) {
  let n = 2166136261;
  for (const c of s) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  return n >>> 0;
}
export function AvatarArt({
  id,
  avatar,
  size = 40,
}: {
  id: string;
  avatar?: string | null;
  size?: number;
}) {
  const key = /^vexa:(\d|1[01]):\d{1,10}$/.test(avatar ?? "")
    ? avatar!
    : defaultAvatar(id);
  const [, kind, seed] = key.split(":"),
    k = Number(kind),
    n = Number(seed),
    color = colors[n % colors.length];
  const ears = [
    <path d="M18 31 17 12 33 25M46 25 63 12 62 33" />,
    <path d="M19 48 17 65 29 60 38 66 48 60 61 65 60 46" />,
    <path d="M39 21V11m-5 0h10M15 34H9v18h8m46-18h8v18h-8" />,
    <path d="m15 37-2-25 22 18m10 0 22-18-2 25" />,
    <>
      <circle cx="24" cy="28" r="12" />
      <circle cx="56" cy="28" r="12" />
    </>,
    <>
      <circle cx="20" cy="23" r="12" />
      <circle cx="60" cy="23" r="12" />
    </>,
    <>
      <ellipse cx="27" cy="19" rx="8" ry="18" />
      <ellipse cx="53" cy="19" rx="8" ry="18" />
    </>,
    <path d="M16 40 12 18 34 27m12 0 22-9-4 22" />,
    <path d="M18 49q-13 23 0 17l9-10q-4 24 9 9l4-8 4 8q13 15 9-9l9 10q13 6 0-17" />,
    <path d="M20 35 3 20 7 52 23 58m37-23 17-15-4 32-16 6" />,
    <path d="m19 31 3-21 13 16m10 0 13-16 3 21" />,
    <>
      <circle cx="19" cy="24" r="12" />
      <circle cx="61" cy="24" r="12" />
    </>,
  ];
  return (
    <svg
      className="avatar-art"
      width={size}
      height={size}
      viewBox="0 0 80 80"
      role="img"
      aria-label={`${avatarNames[k]} avatar`}
      data-avatar={key}
    >
      <rect width="80" height="80" rx="23" fill="#202031" />
      <circle cx="63" cy="13" r="24" fill={color} opacity=".15" />
      <path
        d="m8 62 64-44M-5 49 61 5"
        stroke={color}
        opacity=".12"
        strokeWidth="3"
      />
      <g fill={color} stroke="#202031" strokeWidth="3" strokeLinejoin="round">
        {ears[k]}
        <path
          d={
            k === 2
              ? "M22 23h36q9 0 9 10v23q0 10-10 10H23q-10 0-10-10V33q0-10 9-10"
              : k === 3
                ? "M14 32 40 22 66 32 59 55 40 69 21 55"
                : "M15 43Q15 22 40 22T65 43v7Q65 67 40 67T15 50Z"
          }
        />
      </g>
      {(k === 7 || k === 11) && (
        <g fill="#202031" opacity=".8">
          <ellipse cx="28" cy="43" rx="11" ry="13" />
          <ellipse cx="52" cy="43" rx="11" ry="13" />
        </g>
      )}
      {k === 2 ? (
        <rect x="20" y="34" width="40" height="20" rx="8" fill="#202031" />
      ) : null}
      <g fill={k === 2 || k === 7 || k === 11 ? "#fff4df" : "#202031"}>
        <ellipse cx="29" cy="43" rx="3.5" ry={k === 1 ? 7 : 5} />
        <ellipse cx="51" cy="43" rx="3.5" ry={k === 1 ? 7 : 5} />
      </g>
      <path
        d={
          k === 1
            ? "M36 56q4-7 8 0"
            : k === 3 || k === 0
              ? "m35 52 5 4 5-4M40 56v3"
              : "M34 56q6 6 12 0"
        }
        fill="none"
        stroke="#202031"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <g fill="#fff4df" opacity=".65">
        <ellipse cx="22" cy="52" rx="4" ry="2" />
        <ellipse cx="58" cy="52" rx="4" ry="2" />
      </g>
      <g fill={color}>
        {Array.from({ length: 8 }, (_, i) => (
          <rect
            key={i}
            x={12 + i * 7}
            y={73}
            width="4"
            height={2 + ((n >>> (i * 3)) & 3)}
            rx="1"
          />
        ))}
      </g>
    </svg>
  );
}
export function AvatarPicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value?: string | null;
  onChange: (value: string) => void;
}) {
  const selected = value ?? defaultAvatar(id);
  const seed = selected.split(":")[2] ?? String(hash(id));
  return (
    <fieldset className="avatar-picker">
      <legend>CHOOSE YOUR CHARACTER</legend>
      <div className="avatar-grid">
        {avatarNames.map((name, i) => {
          const key = `vexa:${i}:${seed}`;
          return (
            <button
              type="button"
              key={name}
              aria-label={name}
              aria-pressed={selected === key}
              onClick={() => onChange(key)}
            >
              <AvatarArt id={id} avatar={key} size={56} />
              <span>{name}</span>
            </button>
          );
        })}
      </div>
      <button
        className="secondary-button"
        type="button"
        onClick={() =>
          onChange(
            `vexa:${selected.split(":")[1]}:${crypto.getRandomValues(new Uint32Array(1))[0]}`,
          )
        }
      >
        Remix colors & signature
      </button>
    </fieldset>
  );
}
export function ConnectedProfile({
  user,
  onSave,
}: {
  user: {
    id: string;
    username: string;
    avatar_url?: string | null;
    bio?: string;
  };
  onSave: (value: { avatar: string; bio: string }) => Promise<void>;
}) {
  const [avatar, setAvatar] = useState(
      user.avatar_url ?? defaultAvatar(user.id),
    ),
    [bio, setBio] = useState(user.bio ?? ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await onSave({ avatar, bio });
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="profile-editor-avatar">
        <AvatarArt id={user.id} avatar={avatar} size={80} />
        <strong>{user.username}</strong>
      </div>
      <AvatarPicker id={user.id} value={avatar} onChange={setAvatar} />
      <label className="field-label">
        ABOUT ME
        <input
          className="form-input"
          value={bio}
          maxLength={160}
          onChange={(e) => setBio(e.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button className="primary-button full-width" disabled={busy}>
        {busy ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}
