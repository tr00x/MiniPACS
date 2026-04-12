/** @type {AppTypes.Config} */
window.config = {
  routerBasename: '/ohif',
  extensions: [],
  modes: [],
  showStudyList: false,
  maxNumberOfWebWorkers: 3,
  showLoadingIndicator: true,
  strictZSpacingForVolumeViewport: true,
  defaultDataSourceName: 'orthanc',
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
