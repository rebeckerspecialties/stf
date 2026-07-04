'use strict'

module.exports = {
  oculus: {
    id: 'oculus',
    displayName: 'Meta/Oculus standalone headsets',
    browserCandidates: ['com.oculus.browser'],
    browserDevtoolsSocket: 'localabstract:chrome_devtools_remote',
    models: [
      {
        id: 'oculus-go',
        names: ['Oculus Go', 'Pacific'],
        match: [/oculus\s*go/i, /pacific/i],
        chromiumHint: 98,
        tracking: '3dof',
        webxr: true,
        openxr: false,
        notes: 'Legacy Oculus Go class device. Treat OpenXR API-layer support as unavailable unless a lab-specific runtime proves otherwise.'
      },
      {
        id: 'quest-1',
        names: ['Quest', 'Oculus Quest'],
        match: [/oculus\s*quest$/i, /^quest$/i, /monterey/i],
        chromiumHint: 112,
        tracking: '6dof',
        webxr: true,
        openxr: true
      },
      {
        id: 'quest-2',
        names: ['Quest 2', 'Meta Quest 2', 'Oculus Quest 2'],
        match: [/quest\s*2/i, /hollywood/i],
        chromiumHint: 144,
        tracking: '6dof',
        webxr: true,
        openxr: true
      },
      {
        id: 'quest-3',
        names: ['Quest 3', 'Meta Quest 3'],
        match: [/quest\s*3/i, /eureka/i],
        chromiumHint: 144,
        tracking: '6dof',
        webxr: true,
        openxr: true,
        passthrough: true
      }
    ]
  },

  pico: {
    id: 'pico',
    displayName: 'PICO standalone headsets',
    browserCandidates: [
      'com.picovr.browser',
      'com.pvr.browser',
      'com.bytedance.picobrowser',
      'com.android.browser',
      'com.google.android.apps.chrome'
    ],
    browserDevtoolsSocket: 'localabstract:chrome_devtools_remote',
    models: [
      {
        id: 'pico-4',
        names: ['PICO 4', 'Pico 4'],
        match: [/pico\s*4/i, /pico4/i],
        chromiumHint: 105,
        tracking: '6dof',
        webxr: true,
        openxr: true
      },
      {
        id: 'pico-4-ultra',
        names: ['PICO 4 Ultra', 'Pico 4 Ultra'],
        match: [/pico\s*4\s*ultra/i, /pico4\s*ultra/i],
        chromiumHint: null,
        tracking: '6dof',
        webxr: true,
        openxr: true,
        passthrough: true
      }
    ]
  }
}
