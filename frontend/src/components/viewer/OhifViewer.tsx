interface OhifViewerProps {
  studyInstanceUID: string;
  className?: string;
}

export function OhifViewer({ studyInstanceUID, className }: OhifViewerProps) {
  const src = `/ohif/viewer?StudyInstanceUIDs=${studyInstanceUID}`;

  return (
    <iframe
      src={src}
      className={className || "h-[600px] w-full border-0"}
      allow="fullscreen"
      sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
      title="DICOM Viewer"
    />
  );
}
