-- Auto-prewarm DICOMweb metadata when a study becomes stable.
--
-- OnStableStudy fires after StableAge seconds of no new instances in a study
-- (Orthanc default 60s). By the time it fires, the study is fully uploaded
-- and will not change — exactly when we want to populate the DICOMweb
-- metadata cache.
--
-- RestApiGet hits the built-in DICOMweb plugin handler which reads every
-- instance's DICOM tags, builds the metadata response, and stores it as a
-- gzipped attachment (EnableMetadataCache=true is the Orthanc default).
-- The first real OHIF open then gets a ~200ms response from Orthanc, which
-- nginx caches for 7d → subsequent opens are ~30ms HIT.
--
-- Runs in a worker thread, so blocking here does not delay C-STORE ingest.

function OnStableStudy(studyId, tags, metadata)
  local uid = tags['StudyInstanceUID']
  if uid == nil or uid == '' then
    print('prewarm: study ' .. studyId .. ' missing StudyInstanceUID, skipping')
    return
  end

  local ok, result = pcall(RestApiGet, '/dicom-web/studies/' .. uid .. '/metadata', true)
  if ok then
    print('prewarm: warmed metadata for study ' .. uid .. ' (' .. #result .. ' bytes)')
  else
    print('prewarm: failed for study ' .. uid .. ': ' .. tostring(result))
  end
end
