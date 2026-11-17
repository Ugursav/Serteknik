import { SITE_ORIGIN } from './serteknik-policy';

export const IMAGE_PICKER_SCRIPT = `
(function(){
  if(location.origin!==${JSON.stringify(SITE_ORIGIN)}||window.__srkImageBridge)return;
  window.__srkImageBridge=true;var pending={};
  window.__srkApplyImage=function(id,name,mime,base64){
    var input=pending[id];delete pending[id];if(!input||!input.isConnected||!base64)return;
    try{var raw=atob(base64);var bytes=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    var transfer=new DataTransfer();transfer.items.add(new File([bytes],name,{type:mime}));input.files=transfer.files;
    input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}
    catch(e){window.ReactNativeWebView.postMessage(JSON.stringify({type:'IMAGE_ERROR'}));}
  };
  document.addEventListener('click',function(event){
    var input=event.target;
    if(!input||input.tagName!=='INPUT'||input.type!=='file'||input.multiple||!String(input.accept).includes('image'))return;
    event.preventDefault();event.stopImmediatePropagation();
    var id='image-'+Date.now()+'-'+Math.random().toString(36).slice(2);pending={};pending[id]=input;
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'PICK_IMAGE',id:id}));
  },true);
})();true;
`;
