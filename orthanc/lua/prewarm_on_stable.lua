-- Auto-prewarm DICOMweb + OHIF plugin metadata when a study becomes stable.
--
-- OnStableStudy fires after StableAge seconds of no new instances in a study
-- (60s). By then the study is fully uploaded and won't change — the exact
-- moment to precompute everything viewers will ask for.
--
-- Two prewarms per study, both safe to run in the Lua worker thread:
--
-- 1. /studies/{id}/ohif-dicom-json
--    Triggers the Orthanc OHIF plugin to read every instance's DICOM tags
--    and store the JSON as a SQLite attachment. Viewer opens from that
--    attachment — zero disk I/O at open (1-2s cold, <500ms warm).
--
-- 2. /dicom-web/studies/{uid}/metadata
--    Populates the DICOMweb metadata response which the OHIF viewer and
--    nginx disk cache (7d TTL) both rely on.
--
-- Failures are logged but don't block — study stays usable even if prewarm
-- fails; the first viewer open regenerates on demand.

function OnStableStudy(studyId, tags, metadata)
  local uid = tags['StudyInstanceUID']
  if uid == nil or uid == '' then
    print('prewarm: study ' .. studyId .. ' missing StudyInstanceUID, skipping')
    return
  end

  -- RestApiGet(uri, builtInCalls) — builtInCalls=true *excludes* plugin
  -- routes (counterintuitive). Both /studies/<id>/ohif-dicom-json and
  -- /dicom-web/studies/<uid>/metadata are plugin-registered, so pass `false`
  -- to include plugins in the dispatch. `RestApiGetAfterPlugins` doesn't
  -- exist in orthancteam/orthanc 1.12.
  local ok1, result1 = pcall(RestApiGet, '/studies/' .. studyId .. '/ohif-dicom-json', false)
  if ok1 and result1 ~= nil then
    print('prewarm: OHIF attachment ready for ' .. uid .. ' (' .. #result1 .. ' bytes)')
  else
    print('prewarm: OHIF attachment failed for ' .. uid .. ': ' .. tostring(result1))
  end

  local ok2, result2 = pcall(RestApiGet, '/dicom-web/studies/' .. uid .. '/metadata', false)
  if ok2 and result2 ~= nil then
    print('prewarm: DICOMweb metadata warmed for ' .. uid .. ' (' .. #result2 .. ' bytes)')
  else
    print('prewarm: DICOMweb metadata failed for ' .. uid .. ': ' .. tostring(result2))
  end
end
