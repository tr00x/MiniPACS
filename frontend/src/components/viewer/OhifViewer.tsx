interface OhifViewerProps {
  orthancStudyID: string;
  className?: string;
}

export function OhifViewer({ orthancStudyID, className }: OhifViewerProps) {
  // Orthanc OHIF plugin + dicom-json datasource. The `url=` param points at
  // the precomputed JSON attachment generated OnStableStudy — viewer opens
  // from a single DB read instead of re-reading every .dcm file from disk.
  // Absolute URL via nginx /orthanc/ reverse proxy — relative (../studies/…)
  // would resolve to /studies/… on the MiniPACS frontend, which nginx does
  // not route to Orthanc. Plugin's own server serves the dicom-json endpoint
  // at Orthanc REST root (/studies/{id}/ohif-dicom-json).
  const src = `/ohif/viewer?url=/orthanc/studies/${orthancStudyID}/ohif-dicom-json`;

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
