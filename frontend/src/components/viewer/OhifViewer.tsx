interface OhifViewerProps {
  studyInstanceUID: string;
  className?: string;
}

export function OhifViewer({ studyInstanceUID, className }: OhifViewerProps) {
  const src = `/ohif/viewer?StudyInstanceUIDs=${studyInstanceUID}`;

  return (
    <div className="overflow-hidden w-full max-w-full">
      <iframe
        src={src}
        className={`${className || "h-[600px] w-full"} border-0 max-w-full`}
        style={{ maxWidth: "100%", display: "block" }}
        allow="fullscreen"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
        title="DICOM Viewer"
      />
    </div>
  );
}
