import { useEffect, useRef, useState } from "react";
import { Gauge, Music, PictureInPicture2, Repeat } from "lucide-react";
import type { ViewerProps } from "../core/types";
import { useI18n } from "../i18n";
import { FileBridge, formatBytes } from "../services/fileBridge";
import { BottomToolBar, type BottomToolGroup } from "../components/BottomToolBar";
import { ViewerError, ViewerLoading } from "../components/StatusView";

const SPEEDS = [0.75, 1.0, 1.25, 1.5, 2.0] as const;
const AUDIO_EXTS = new Set(["mp3", "flac", "wav", "m4a", "aac", "opus", "wma", "ogg"]);

export function MediaViewer({ file }: ViewerProps) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [speed, setSpeed] = useState<number>(1.0);
  const [loop, setLoop] = useState(false);
  const isAndroid = FileBridge.isAndroid();
  const [streamSrc, setStreamSrc] = useState<string | null>(() =>
    isAndroid ? null : FileBridge.toAssetUrl(file.path)
  );
  const [streamError, setStreamError] = useState<string | null>(null);

  const isAudio = AUDIO_EXTS.has(file.ext);
  const supportsPiP = !isAudio && Boolean(document.pictureInPictureEnabled);

  useEffect(() => {
    setStreamError(null);
    if (!isAndroid) {
      setStreamSrc(FileBridge.toAssetUrl(file.path));
      return;
    }

    let cancelled = false;
    setStreamSrc(null);
    FileBridge.getMediaStreamUrl(file.path)
      .then((url) => {
        if (!cancelled) setStreamSrc(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStreamError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [file.path, file.size, isAndroid]);

  const applySpeed = (nextSpeed: number) => {
    setSpeed(nextSpeed);
    if (videoRef.current) videoRef.current.playbackRate = nextSpeed;
    if (audioRef.current) audioRef.current.playbackRate = nextSpeed;
  };

  const togglePiP = async () => {
    if (!videoRef.current) return;
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (videoRef.current.requestPictureInPicture) {
      await videoRef.current.requestPictureInPicture();
    }
  };

  const toolGroups: BottomToolGroup[] = [
    {
      id: "speed",
      label: t("media.speed"),
      icon: <Gauge size={14} />,
      active: speed !== 1,
      items: SPEEDS.map((sp) => ({
        kind: "action",
        key: `sp-${sp}`,
        label: `${sp}x`,
        active: speed === sp,
        dismiss: "instant",
        onClick: () => applySpeed(sp),
      })),
    },
    {
      id: "play",
      label: t("media.play"),
      icon: <Repeat size={14} />,
      active: loop,
      items: [
        {
          kind: "action",
          key: "loop",
          label: t("media.loop"),
          icon: <Repeat size={14} />,
          active: loop,
          dismiss: "instant",
          title: t("media.loopTitle"),
          onClick: () => setLoop((l) => !l),
        },
        ...(supportsPiP
          ? [
              {
                kind: "action" as const,
                key: "pip",
                label: t("media.pip"),
                icon: <PictureInPicture2 size={14} />,
                dismiss: "instant" as const,
                title: t("media.pipTitle"),
                onClick: togglePiP,
              },
            ]
          : []),
      ],
    },
  ];

  return (
    <div className="viewer-shell viewer-shell-rel">
      <div className="media-stage">
        {streamError ? (
          <ViewerError title={t("media.errTitle")} detail={streamError} />
        ) : !streamSrc ? (
          <ViewerLoading message={t("media.loading")} />
        ) : isAudio ? (
          <div className="audio-card">
            <div className="audio-disc">
              <Music size={48} />
            </div>
            <h3>{file.name}</h3>
            <audio
              ref={audioRef}
              key={streamSrc}
              src={streamSrc}
              controls
              autoPlay
              loop={loop}
              className="audio-player"
              onLoadedMetadata={() => {
                if (audioRef.current) audioRef.current.playbackRate = speed;
              }}
            />
          </div>
        ) : (
          <div className="video-wrap">
            <video
              ref={videoRef}
              key={streamSrc}
              src={streamSrc}
              controls
              autoPlay
              playsInline
              loop={loop}
              className="video-player"
              onLoadedMetadata={() => {
                if (videoRef.current) videoRef.current.playbackRate = speed;
              }}
            />
          </div>
        )}
        <div className="model-stats-hud">
          {isAudio ? t("media.audioHud") : t("media.videoHud")} · {formatBytes(file.size)}
        </div>
      </div>

      <BottomToolBar groups={toolGroups} />
    </div>
  );
}
