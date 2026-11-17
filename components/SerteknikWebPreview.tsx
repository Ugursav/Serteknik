import React from 'react';
import { SITE_ORIGIN } from '@/lib/serteknik-policy';
export default function SerteknikWebPreview() {
  return React.createElement('iframe', {
    src: SITE_ORIGIN,
    title: 'SerTeknik',
    allow: 'camera; clipboard-write',
    style: { width: '100%', height: '100%', border: 0, display: 'block', background: '#f7fafc' },
  });
}
