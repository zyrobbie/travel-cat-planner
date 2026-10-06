import { useState } from "react";
import type { AppearanceId, Letter } from "./model";
import { dailyImage, eventImage, postcardImage, responsiveCat, responsiveDaily } from "./assets";
import { homePosePlacement } from "../ui-daily-core-v1/home-poses.mjs";

export type HomePose = "sit" | "stretch" | "play-ball";
const pct = (value: number, total: number) => `${(value / total) * 100}%`;
const retry = (url: string, attempt: number) => attempt ? `${url}?retry=${attempt}` : url;
const srcSet = (value: string, attempt: number) =>
  value.split(", ").map((part) => {
    const [url, width] = part.split(" ");
    return `${retry(url, attempt)} ${width}`;
  }).join(", ");

function useImageStatus() {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState(false);
  return {
    attempt, loaded, error,
    mark: (key: string) => setLoaded((previous) => ({ ...previous, [key]: true })),
    fail: () => setError(true),
    again: () => { setLoaded({}); setError(false); setAttempt((n) => n + 1); },
  };
}

export function HomeScene({ appearance, name, trip, pose }: {
  appearance: AppearanceId | null; name: string; trip: boolean; pose: HomePose;
}) {
  const status = useImageStatus();
  const room = responsiveDaily("home-empty");
  const ready = status.loaded.room && (trip || !appearance || status.loaded.cat);
  let cat: React.ReactNode = null;
  if (!trip && appearance) {
    if (pose === "sit") {
      const source = responsiveCat(appearance);
      cat = <>
        <span className={`e3-sit-shadow ${appearance}`} aria-hidden="true" />
        <img className={`e3-home-cat e3-sit-cat ${appearance}`} src={retry(source.src, status.attempt)} srcSet={srcSet(source.srcSet, status.attempt)} sizes="(max-width:699px) 18vw, 105px" alt={`${name}在家中坐着`} onLoad={() => status.mark("cat")} onError={status.fail} />
      </>;
    } else {
      const placement = homePosePlacement(appearance, pose);
      cat = <>
        {placement.contacts.map(([left, top, width, height]: number[], index: number) =>
          <span key={index} className="e3-pose-contact" aria-hidden="true" style={{left:pct(left,1536),top:pct(top,1024),width:pct(width,1536),height:pct(height,1024)}} />)}
        <img className="e3-home-cat e3-pose-cat" src={retry(dailyImage(`home-poses/${pose}-${appearance}-768.webp`), status.attempt)} style={{left:pct(placement.left,1536),top:pct(placement.top,1024),width:pct(placement.width,1536)}} alt={`${name}在家中${pose === "stretch" ? "伸懒腰" : "玩球"}`} onLoad={() => status.mark("cat")} onError={status.fail} />
      </>;
    }
  }
  return <div className={`e3-scene e3-home-scene${ready ? " is-ready" : ""}`} data-home-pose={pose} aria-label={trip ? "小猫旅行中，家里暂时没有小猫" : `${name}在熟悉的家里`}>
    {!status.error ? <>
      <img className="e3-room" src={retry(room.src, status.attempt)} srcSet={srcSet(room.srcSet, status.attempt)} sizes="(max-width:699px) calc(100vw - 32px), 564px" alt="" onLoad={() => status.mark("room")} onError={status.fail} />
      {cat}
      {!ready && <span className="e3-scene-loading">正在布置小猫的家…</span>}
    </> : <div className="e3-scene-fallback"><p>画面暂时没能加载，原有记录仍在。</p><button type="button" onClick={status.again}>再试一次</button></div>}
    {!trip && !appearance && <p className="e3-legacy-note">这份旧体验没有记录外观，原有小猫和来信已保留。</p>}
  </div>;
}

function LetterScene({ image, alt, unavailable }: {
  image: ReturnType<typeof responsiveDaily> | null; alt: string; unavailable: string;
}) {
  const status = useImageStatus();
  if (!image) return <div className="e3-scene e3-scene-fallback">{unavailable}</div>;
  return <div className={`e3-scene e3-letter-scene${status.loaded.picture ? " is-ready" : ""}`}>
    {!status.error ? <>
      <img src={retry(image.src, status.attempt)} srcSet={srcSet(image.srcSet, status.attempt)} sizes="(max-width:699px) calc(100vw - 32px), 564px" alt={alt} onLoad={() => status.mark("picture")} onError={status.fail} />
      {!status.loaded.picture && <span className="e3-scene-loading">正在展开来信画面…</span>}
    </> : <div className="e3-scene-fallback"><p>画面暂时没能加载，正文仍可阅读。</p><button type="button" onClick={status.again}>再试一次</button></div>}
  </div>;
}

export function EventScene({ letter, appearance }: { letter: Letter; appearance: AppearanceId | null }) {
  const contentId = letter.snapshot.contentId ?? letter.id.slice(letter.id.lastIndexOf(":") + 1);
  const image = appearance ? eventImage(contentId, appearance) : null;
  return <LetterScene key={`${letter.id}:${appearance}`} image={image} alt={`${letter.snapshot.catName}的${letter.snapshot.title}来信画面`} unavailable={appearance ? "这封旧来信暂无对应的已批准画面，正文仍可阅读。" : "旧体验尚未记录小猫外观，正文仍可阅读。"} />;
}

export function PostcardScene({ letter, appearance }: { letter: Letter; appearance: AppearanceId | null }) {
  const image = appearance ? postcardImage(letter.snapshot.scene, appearance) : null;
  return <LetterScene key={`${letter.id}:${appearance}`} image={image} alt={`${letter.snapshot.catName}的旅行画面`} unavailable={appearance ? "这封旅行信暂无对应的已批准画面，正文仍可阅读。" : "旧体验尚未记录小猫外观，旅行信正文仍可阅读。"} />;
}
