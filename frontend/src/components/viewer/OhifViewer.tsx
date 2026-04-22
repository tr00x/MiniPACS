interface OhifViewerProps {
  studyInstanceUID: string;
  className?: string;
}

// Named `OhifViewer` for historical reasons but embeds Orthanc's Stone Web
// Viewer — a ~1MB WASM viewer that opens studies in 2-3s cold vs 25-40s for
// OHIF. Stone covers the day-to-day radiologist workflow (scroll, W/L, zoom,
// measure). OHIF stays available via the "Open in OHIF" button on the study
// detail page for the rare cases that need MPR/segmentation/3D.
export function OhifViewer({ studyInstanceUID, className }: OhifViewerProps) {
  const src = `/stone-webviewer/index.html?study=${studyInstanceUID}`;

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
