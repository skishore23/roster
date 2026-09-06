/**
 * Progressive enhancement for simple single-value selects.
 *
 * The native select remains the form authority and no-JavaScript fallback.
 * Browsers with the Popover API receive a themed listbox projection that
 * mirrors value, disabled state, and change events without changing form data.
 */
export const selectControlBootstrap = (): string => `(()=>{
  if(typeof HTMLSelectElement==='undefined'||typeof HTMLElement==='undefined'||typeof CSS==='undefined'||!CSS.supports?.('anchor-name: --ui-select-anchor')||!('showPopover' in HTMLElement.prototype))return;
  const selector='select[data-ui-select]';
  let sequence=0;
  const labelFor=(select)=>select.getAttribute('aria-label')||select.labels?.[0]?.textContent?.replace(/\\s+/g,' ').trim()||'Choose an option';
  const available=(select)=>[...select.options].filter((option)=>!option.hidden);
  const selected=(select)=>select.selectedOptions[0]||available(select)[0];
  const enhance=(select)=>{
    if(!(select instanceof HTMLSelectElement)||select.multiple||select.dataset.uiSelectEnhanced==='true')return;
    const id=select.id||'ui-select-'+(++sequence);
    const root=document.createElement('span');
    root.className='ui-select';
    root.dataset.slot='select-control';
    root.dataset.state='closed';
    if(select.hasAttribute('data-ui-select-fill'))root.dataset.fill='true';
    select.parentNode?.insertBefore(root,select);
    root.append(select);
    select.dataset.uiSelectEnhanced='true';
    select.tabIndex=-1;
    select.setAttribute('aria-hidden','true');
    const trigger=document.createElement('button');
    trigger.type='button';
    trigger.className='ui-select-trigger';
    trigger.dataset.slot='select-trigger';
    trigger.id=id+'-trigger';
    trigger.setAttribute('aria-haspopup','listbox');
    trigger.setAttribute('aria-expanded','false');
    const describedBy=select.getAttribute('aria-describedby');
    if(describedBy)trigger.setAttribute('aria-describedby',describedBy);
    if(select.required)trigger.setAttribute('aria-required','true');
    const value=document.createElement('span');
    value.className='ui-select-value';
    const chevron=document.createElement('span');
    chevron.className='ui-select-chevron';
    chevron.setAttribute('aria-hidden','true');
    trigger.append(value,chevron);
    root.append(trigger);
    const list=document.createElement('div');
    list.className='ui-select-list';
    list.dataset.slot='select-content';
    list.id=id+'-listbox';
    list.setAttribute('role','listbox');
    list.setAttribute('aria-label',labelFor(select));
    list.setAttribute('popover','auto');
    trigger.setAttribute('aria-controls',list.id);
    root.append(list);
    let typeahead='',typeaheadTimer;
    const optionButtons=()=>[...list.querySelectorAll('[role="option"]')].filter((option)=>!option.disabled);
    const focusAt=(index)=>{const options=optionButtons();if(!options.length)return;options[(index+options.length)%options.length]?.focus();};
    const sync=()=>{
      const current=selected(select);
      value.textContent=current?.textContent?.trim()||'Choose';
      trigger.title=current?.dataset.description||'';
      trigger.disabled=select.disabled;
      trigger.setAttribute('aria-label',labelFor(select)+': '+value.textContent);
      root.dataset.disabled=String(select.disabled);
      for(const option of list.querySelectorAll('[role="option"]')){
        const active=option.dataset.value===select.value;
        option.setAttribute('aria-selected',String(active));
        option.dataset.state=active?'selected':'idle';
      }
    };
    const rebuild=()=>{
      const fragment=document.createDocumentFragment();
      for(const option of available(select)){
        const item=document.createElement('button');
        item.type='button';
        item.className='ui-select-option';
        item.dataset.slot='select-option';
        item.dataset.value=option.value;
        item.setAttribute('role','option');
        item.tabIndex=-1;
        item.disabled=option.disabled;
        const copy=document.createElement('span');
        const title=document.createElement('strong');
        title.textContent=option.textContent?.trim()||option.value;
        copy.append(title);
        if(option.dataset.description){const description=document.createElement('small');description.textContent=option.dataset.description;copy.append(description);}
        const mark=document.createElement('span');
        mark.className='ui-select-option-mark';
        mark.setAttribute('aria-hidden','true');
        mark.textContent='✓';
        item.append(copy,mark);
        item.addEventListener('click',()=>{
          if(item.disabled)return;
          select.value=option.value;
          select.dispatchEvent(new Event('change',{bubbles:true}));
          sync();
          list.hidePopover();
          trigger.focus();
        });
        fragment.append(item);
      }
      list.replaceChildren(fragment);
      sync();
    };
    const open=(edge)=>{
      if(trigger.disabled)return;
      list.showPopover();
      queueMicrotask(()=>{
        const options=optionButtons();
        const current=Math.max(0,options.findIndex((option)=>option.dataset.value===select.value));
        focusAt(edge==='first'?0:edge==='last'?options.length-1:current);
      });
    };
    const move=(delta)=>{const options=optionButtons();const index=options.indexOf(document.activeElement);focusAt((index<0?0:index)+delta);};
    trigger.addEventListener('click',()=>list.matches(':popover-open')?list.hidePopover():open());
    trigger.addEventListener('keydown',(event)=>{
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();if(!list.matches(':popover-open'))open(event.key==='ArrowDown'?'first':'last');else move(event.key==='ArrowDown'?1:-1);return;}
      if(event.key==='Home'||event.key==='End'){event.preventDefault();if(!list.matches(':popover-open'))open(event.key==='Home'?'first':'last');else focusAt(event.key==='Home'?0:optionButtons().length-1);return;}
      if(event.key.length===1&&!event.metaKey&&!event.ctrlKey&&!event.altKey){typeahead+=event.key.toLocaleLowerCase();clearTimeout(typeaheadTimer);typeaheadTimer=setTimeout(()=>{typeahead='';},500);const options=optionButtons();const match=options.find((option)=>option.textContent?.trim().toLocaleLowerCase().startsWith(typeahead));if(match){event.preventDefault();if(!list.matches(':popover-open'))list.showPopover();match.focus();}}
    });
    list.addEventListener('click',(event)=>event.stopPropagation());
    list.addEventListener('keydown',(event)=>{
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();move(event.key==='ArrowDown'?1:-1);}
      else if(event.key==='Home'||event.key==='End'){event.preventDefault();focusAt(event.key==='Home'?0:optionButtons().length-1);}
      else if(event.key==='Escape'){event.preventDefault();list.hidePopover();trigger.focus();}
      else if(event.key==='Tab')list.hidePopover();
      else if((event.key==='Enter'||event.key===' ')&&document.activeElement?.getAttribute('role')==='option'){event.preventDefault();document.activeElement.click();}
    });
    list.addEventListener('toggle',(event)=>{
      const open=event.newState==='open';
      root.dataset.state=open?'open':'closed';
      trigger.setAttribute('aria-expanded',String(open));
    });
    select.addEventListener('change',sync);
    select.addEventListener('ui-select-sync',()=>{rebuild();sync();});
    select.addEventListener('focus',()=>trigger.focus());
    new MutationObserver(rebuild).observe(select,{attributes:true,childList:true,subtree:true,attributeFilter:['disabled','hidden','label','selected','data-description']});
    rebuild();
  };
  const initialize=(root=document)=>root.querySelectorAll(selector).forEach(enhance);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>initialize(),{once:true});else initialize();
  new MutationObserver((records)=>{for(const record of records)for(const node of record.addedNodes)if(node instanceof Element){if(node.matches(selector))enhance(node);initialize(node);}}).observe(document.documentElement,{childList:true,subtree:true});
})();`;

export const selectControlCss = (): string => `
select[data-ui-select]{min-height:34px;padding:0 30px 0 10px;border:1px solid var(--border-default,var(--line,#c5ced8));border-radius:var(--radius-control,var(--radius-sm,8px));color:var(--text-primary,var(--ink,#17202a));background-color:var(--surface-raised,var(--raised,#f1f3f6));background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 13px) 14px,calc(100% - 9px) 14px;background-repeat:no-repeat;background-size:4px 4px;appearance:none;cursor:pointer}
.ui-select{position:relative;min-width:0;display:inline-flex;anchor-scope:--ui-select-anchor;vertical-align:middle}.ui-select[data-fill="true"]{width:100%}.ui-select>select[data-ui-select-enhanced="true"]{position:absolute!important;width:1px!important;height:1px!important;margin:-1px!important;padding:0!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;opacity:0!important;pointer-events:none!important}.ui-select-trigger{anchor-name:--ui-select-anchor;min-width:0;min-height:34px;display:grid;grid-template-columns:minmax(0,1fr) 16px;align-items:center;gap:8px;padding:0 9px 0 11px;border:1px solid var(--border-default,var(--line,#c5ced8));border-radius:var(--radius-control,var(--radius-sm,8px));color:var(--text-primary,var(--ink,#17202a));background:linear-gradient(180deg,color-mix(in srgb,var(--surface-raised,var(--raised,#f1f3f6)) 92%,white),var(--surface-raised,var(--raised,#f1f3f6)));box-shadow:inset 0 1px rgba(255,255,255,.04),0 1px 2px rgba(0,0,0,.12);cursor:pointer;font-size:11px;font-weight:650;text-align:left}.ui-select[data-fill="true"] .ui-select-trigger{width:100%}.ui-select-trigger:hover{border-color:var(--border-strong,var(--line,#9eabb9));background:var(--surface-hover,var(--panel-2,#e7ebf0))}.ui-select-trigger:focus-visible,.ui-select[data-state="open"] .ui-select-trigger{outline:0;border-color:var(--focus-ring,var(--agent-accent,var(--blue,#0b5cad)));box-shadow:0 0 0 3px color-mix(in srgb,var(--focus-ring,var(--agent-accent,var(--blue,#0b5cad))) 16%,transparent)}.ui-select-trigger:disabled{opacity:.48;cursor:not-allowed}.ui-select-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ui-select-chevron{position:relative;width:14px;height:14px;display:grid;place-items:center;color:var(--text-tertiary,var(--faint,#536170))}.ui-select-chevron:before,.ui-select-chevron:after{content:"";position:absolute;top:6px;width:6px;height:1.5px;border-radius:2px;background:currentColor;transition:transform .16s ease}.ui-select-chevron:before{left:1px;transform:rotate(42deg)}.ui-select-chevron:after{right:1px;transform:rotate(-42deg)}.ui-select[data-state="open"] .ui-select-chevron:before{transform:rotate(-42deg)}.ui-select[data-state="open"] .ui-select-chevron:after{transform:rotate(42deg)}
.ui-select-list{position:fixed;position-anchor:--ui-select-anchor;z-index:2147483000;inset:auto;top:anchor(bottom);left:anchor(left);min-width:anchor-size(width);width:max-content;max-width:min(360px,calc(100vw - 16px));max-height:min(360px,calc(100vh - 16px));margin:6px 0 0;overflow:auto;overscroll-behavior:contain;padding:5px;border:1px solid var(--border-strong,var(--line,#9eabb9));border-radius:var(--radius-card,var(--radius-md,12px));color:var(--text-primary,var(--ink,#17202a));background:color-mix(in srgb,var(--surface-overlay,var(--panel,#fff)) 96%,transparent);box-shadow:var(--shadow-overlay,0 24px 70px rgba(0,0,0,.35));backdrop-filter:blur(18px);scrollbar-width:thin;position-try-fallbacks:flip-block,flip-inline}.ui-select-list::backdrop{background:transparent}.ui-select-option{width:100%;min-height:40px;display:grid;grid-template-columns:minmax(0,1fr) 18px;align-items:center;gap:10px;padding:7px 8px;border:0;border-radius:var(--radius-control,var(--radius-sm,8px));color:inherit;background:transparent;cursor:pointer;text-align:left}.ui-select-option:hover,.ui-select-option:focus-visible{outline:0;color:var(--text-primary,var(--ink,#17202a));background:var(--surface-hover,var(--panel-2,#e7ebf0))}.ui-select-option[data-state="selected"]{background:color-mix(in srgb,var(--accent,var(--agent-accent,var(--blue,#0b5cad))) 12%,var(--surface-raised,var(--raised,#f1f3f6)))}.ui-select-option:disabled{opacity:.42;cursor:not-allowed}.ui-select-option>span:first-child{min-width:0;display:grid;gap:2px}.ui-select-option strong{overflow:hidden;text-overflow:ellipsis;color:inherit;font-size:11px;font-weight:650;white-space:nowrap}.ui-select-option small{overflow:hidden;text-overflow:ellipsis;color:var(--text-secondary,var(--muted,#4d5a68));font-size:9px;line-height:1.35;white-space:nowrap}.ui-select-option-mark{visibility:hidden;color:var(--accent-strong,var(--agent-accent,var(--blue,#0b5cad)));font-size:11px;text-align:center}.ui-select-option[data-state="selected"] .ui-select-option-mark{visibility:visible}
@media(pointer:coarse){.ui-select-trigger,.ui-select-option{min-height:44px}}@media(prefers-reduced-motion:reduce){.ui-select-chevron:before,.ui-select-chevron:after{transition:none}}
`;
