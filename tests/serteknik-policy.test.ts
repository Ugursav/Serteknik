import { describe, it, expect } from 'vitest';
import { SITE_ORIGIN, navigationAction, isTrustedUrl, BACK_SCRIPT } from '../lib/serteknik-policy';
import { IMAGE_PICKER_SCRIPT } from '../lib/serteknik-image-script';
describe('SerTeknik Android navigation',()=>{
 it('keeps service and product pages in the app',()=>{expect(navigationAction(SITE_ORIGIN+'/admin')).toBe('internal');expect(navigationAction(SITE_ORIGIN+'/store?product=5')).toBe('internal')});
 it('opens WhatsApp, phone and email externally',()=>{for(const url of ['https://wa.me/905019544115','tel:05019544115','mailto:serteknikiletisim@gmail.com'])expect(navigationAction(url)).toBe('external')});
 it('blocks executable and local file links',()=>{for(const url of ['javascript:alert(1)','file:///etc/passwd','http://serteknik.elektrik.workers.dev'])expect(navigationAction(url)).toBe('blocked')});
 it('rejects untrusted native messages',()=>{expect(isTrustedUrl('https://serteknik.elektrik.workers.dev.evil.test')).toBe(false);expect(isTrustedUrl(SITE_ORIGIN+'/admin')).toBe(true)});
 it('has a modal-aware back button and functional File replacement',()=>{expect(BACK_SCRIPT).toContain('.srk-modal-close');expect(IMAGE_PICKER_SCRIPT).toContain('new DataTransfer()');expect(IMAGE_PICKER_SCRIPT).toContain("new Event('change',{bubbles:true})");expect(IMAGE_PICKER_SCRIPT).toContain("type:'PICK_IMAGE'")});
});
