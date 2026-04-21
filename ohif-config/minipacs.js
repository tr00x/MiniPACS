/** @type {AppTypes.Config} */
window.config = {
  routerBasename: '/ohif',
  extensions: [],
  modes: [],
  showStudyList: false,
  maxNumberOfWebWorkers: 8,
  showLoadingIndicator: true,
  strictZSpacingForVolumeViewport: true,
  defaultDataSourceName: 'orthanc',
  // Aggressively prefetch study frames in the background so scroll/scrub
  // hits images that are already decoded in memory instead of triggering a
  // WADO-RS round-trip per frame. Default OHIF ships with the prefetcher
  // disabled ("StudyPrefetcher is not enabled") — that's the reason
  // displaySetsToFirstImage was 20s on a 14-series study.
  studyPrefetcher: {
    enabled: true,
    displaySetsCount: 2,
    maxNumPrefetchRequests: 100,
    order: 'closest',
  },
  // Don't wait for every frame to finish before showing the first one.
  // Stream in order, paint as soon as first frame is decoded.
  useSharedArrayBuffer: 'AUTO',
  useNorm16Texture: false,
  // Request multipart/related frames without outer quotes (Orthanc accepts
  // both; matching what browsers send by default cuts one proxy rewrite).
  whiteLabeling: {
    createLogoComponentFn: function(React) {
      return React.createElement('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '0 8px',
        }
      }, [
        React.createElement('div', {
          key: 'icon',
          style: {
            width: '28px',
            height: '28px',
            borderRadius: '6px',
            background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            fontWeight: 'bold',
            color: 'white',
          }
        }, 'M'),
        React.createElement('span', {
          key: 'text',
          style: {
            fontSize: '15px',
            fontWeight: '600',
            color: '#e2e8f0',
            letterSpacing: '-0.02em',
          }
        }, 'MiniPACS Viewer'),
      ]);
    },
  },
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'orthanc',
      configuration: {
        friendlyName: 'MiniPACS Orthanc',
        name: 'orthanc',
        wadoUriRoot: '/dicom-web',
        qidoRoot: '/dicom-web',
        wadoRoot: '/dicom-web',
        qidoSupportsIncludeField: false,
        supportsReject: false,
        dicomUploadEnabled: false,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: false,
        supportsWildcard: true,
        omitQuotationForMultipartRequest: true,
        bulkDataURI: {
          enabled: true,
        },
      },
    },
  ],
};
