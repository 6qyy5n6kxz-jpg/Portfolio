let config={};
let state={page:0,total:0,items:[],search:'',season:'',format:'',blacklight:false};
let searchTimer=null;

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
const formatLabel=value=>({
  '16x20':'16×20 Canvas','11x14':'11×14 Canvas','8x10':'8×10 Canvas',
  wine_glass:'Wine Glass',wood_pallet:'Wood Pallet',doormat:'Doormat',other:'Other'
}[value]||value||'Canvas');

async function loadConfig(){
  const response=await fetch('./public/config.json',{cache:'no-store'});
  if(!response.ok)throw new Error('Portfolio configuration could not be loaded.');
  return response.json();
}

function endpoint(){
  const base=String(config.SUPABASE_URL||'').replace(/\/$/,'');
  if(!base||!config.SUPABASE_PUBLISHABLE_KEY)return null;
  return `${base}/rest/v1/rpc/get_public_project_portfolio_v2`;
}

async function fetchCanonicalPortfolio(){
  const url=endpoint();
  if(!url)return null;
  const limit=Number(config.ITEMS_PER_PAGE||30);
  const response=await fetch(url,{
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      apikey:config.SUPABASE_PUBLISHABLE_KEY,
      Authorization:`Bearer ${config.SUPABASE_PUBLISHABLE_KEY}`,
    },
    body:JSON.stringify({
      p_search:state.search||null,
      p_season:state.season||null,
      p_format:state.format||null,
      p_tag:null,
      p_blacklight:state.blacklight?true:null,
      p_limit:limit,
      p_offset:state.page*limit,
    }),
  });
  if(!response.ok)throw new Error('The painting catalog is temporarily unavailable.');
  return response.json();
}

async function fetchLegacyFallback(){
  const response=await fetch('./public/manifest.json',{cache:'no-store'});
  if(!response.ok)throw new Error('The painting catalog is temporarily unavailable.');
  const raw=await response.json();
  const normalized=raw.map(item=>({
    id:item.id,
    title:String(item.name||'Untitled').replace(/\.[a-z0-9]{2,5}$/i,'').replace(/[_-]+/g,' '),
    primary_format:'16x20',
    formats:['16x20'],
    blacklight:false,
    season:item.season||null,
    tags:Array.isArray(item.tags)?item.tags:[],
    difficulty:item.difficulty||null,
    orientation:item.orientation||null,
    dominant_color:item.color||null,
    description:item.description||null,
    image_url:item.src||item.image||null,
    image_fallbacks:Array.isArray(item.fallbacks)?item.fallbacks:[],
  }));
  const q=state.search.toLowerCase();
  const filtered=normalized.filter(item=>{
    if(q&&!([item.title,item.description,...item.tags].join(' ').toLowerCase().includes(q)))return false;
    if(state.season&&item.season!==state.season)return false;
    if(state.format&&!item.formats.includes(state.format))return false;
    if(state.blacklight&&!item.blacklight)return false;
    return true;
  });
  const limit=Number(config.ITEMS_PER_PAGE||30);
  const start=state.page*limit;
  return {
    items:filtered.slice(start,start+limit),
    total:filtered.length,
    facets:{seasons:[...new Set(normalized.map(x=>x.season).filter(Boolean))].sort(),tags:[]},
    fallback:true,
  };
}

async function loadPage(){
  $('loadingIndicator').hidden=false;
  $('errorMessage').hidden=true;
  $('galleryGrid').innerHTML='';
  try{
    const payload=(await fetchCanonicalPortfolio())||await fetchLegacyFallback();
    state.items=payload.items||[];
    state.total=Number(payload.total||0);
    renderSeasonOptions(payload.facets?.seasons||[]);
    renderGallery();
    renderPagination();
    $('resultCount').textContent=`${state.total.toLocaleString()} painting${state.total===1?'':'s'}`;
    $('resultTitle').textContent=payload.fallback?'Painting Portfolio':'Painting Portfolio';
  }catch(error){
    $('errorMessage').textContent=error.message||'Unable to load the portfolio.';
    $('errorMessage').hidden=false;
    renderPagination();
  }finally{
    $('loadingIndicator').hidden=true;
  }
}

function renderSeasonOptions(seasons){
  const select=$('seasonFilter');
  const current=state.season;
  const values=[...new Set(seasons.filter(Boolean))].sort();
  select.innerHTML='<option value="">All seasons</option>'+values.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');
  select.value=current;
}

function imageMarkup(item){
  const sources=[item.image_url,...(item.image_fallbacks||[])].filter(Boolean);
  const first=sources[0]||'';
  const fallbacks=encodeURIComponent(JSON.stringify(sources.slice(1)));
  return `<img src="${esc(first)}" alt="${esc(item.title)}" loading="lazy" data-fallbacks="${fallbacks}">`;
}

function renderGallery(){
  const grid=$('galleryGrid');
  if(!state.items.length){
    grid.innerHTML='<div class="state-card empty"><strong>No paintings found.</strong><span>Try changing your search or filters.</span></div>';
    return;
  }
  grid.innerHTML=state.items.map(item=>`
    <article class="painting-card" tabindex="0" data-id="${esc(item.id)}">
      <div class="painting-image">${imageMarkup(item)}</div>
      <div class="painting-copy">
        <h3>${esc(item.title)}</h3>
        <p class="painting-meta">${esc(item.season||'Any season')} · ${esc(formatLabel(item.primary_format))}${item.difficulty?` · Difficulty ${Number(item.difficulty)}`:''}</p>
        <div class="badges">
          ${item.blacklight?'<span>Blacklight</span>':''}
          ${(item.formats||[]).slice(0,3).map(format=>`<span>${esc(formatLabel(format))}</span>`).join('')}
        </div>
      </div>
    </article>`).join('');

  grid.querySelectorAll('img[data-fallbacks]').forEach(img=>{
    img.addEventListener('error',()=>{
      let remaining=[];
      try{remaining=JSON.parse(decodeURIComponent(img.dataset.fallbacks||'%5B%5D'));}catch{}
      const next=remaining.shift();
      if(next){
        img.dataset.fallbacks=encodeURIComponent(JSON.stringify(remaining));
        img.src=next;
      }else img.closest('.painting-image')?.classList.add('image-missing');
    });
  });

  grid.querySelectorAll('.painting-card').forEach(card=>{
    const open=()=>openDialog(state.items.find(x=>String(x.id)===card.dataset.id));
    card.addEventListener('click',open);
    card.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
  });
}

function openDialog(item){
  if(!item)return;
  $('dialogTitle').textContent=item.title;
  $('dialogMeta').textContent=[
    item.season,
    (item.formats||[]).map(formatLabel).join(' · '),
    item.difficulty?`Difficulty ${item.difficulty}/5`:null,
    item.blacklight?'Blacklight':null,
  ].filter(Boolean).join(' · ');
  $('dialogDescription').textContent=item.description||'Choose this painting for a Wine & Canvas Toledo event.';
  $('dialogTags').innerHTML=(item.tags||[]).slice(0,10).map(tag=>`<span>${esc(tag)}</span>`).join('');
  const sources=[item.image_url,...(item.image_fallbacks||[])].filter(Boolean);
  $('dialogImage').src=sources[0]||'';
  $('dialogImage').alt=item.title;
  $('paintingDialog').showModal();
}

function renderPagination(){
  const limit=Number(config.ITEMS_PER_PAGE||30);
  const pages=Math.max(1,Math.ceil(state.total/limit));
  if(state.page>=pages)state.page=Math.max(0,pages-1);
  $('pageInfo').textContent=`Page ${Math.min(state.page+1,pages)} of ${pages}`;
  $('prevBtn').disabled=state.page<=0;
  $('nextBtn').disabled=state.page+1>=pages;
}

function resetPageAndLoad(){
  state.page=0;
  loadPage();
}

function bind(){
  $('searchInput').addEventListener('input',event=>{
    clearTimeout(searchTimer);
    searchTimer=setTimeout(()=>{state.search=event.target.value.trim();resetPageAndLoad();},250);
  });
  $('seasonFilter').addEventListener('change',event=>{state.season=event.target.value;resetPageAndLoad();});
  $('formatFilter').addEventListener('change',event=>{state.format=event.target.value;resetPageAndLoad();});
  $('blacklightFilter').addEventListener('change',event=>{state.blacklight=event.target.checked;resetPageAndLoad();});
  $('clearFiltersBtn').addEventListener('click',()=>{
    state={...state,page:0,search:'',season:'',format:'',blacklight:false};
    $('searchInput').value='';
    $('seasonFilter').value='';
    $('formatFilter').value='';
    $('blacklightFilter').checked=false;
    loadPage();
  });
  $('prevBtn').addEventListener('click',()=>{if(state.page>0){state.page--;loadPage();window.scrollTo({top:0,behavior:'smooth'});}});
  $('nextBtn').addEventListener('click',()=>{state.page++;loadPage();window.scrollTo({top:0,behavior:'smooth'});});
  $('dialogClose').addEventListener('click',()=>$('paintingDialog').close());
  $('paintingDialog').addEventListener('click',event=>{if(event.target===$('paintingDialog'))$('paintingDialog').close();});
}

async function init(){
  try{
    config=await loadConfig();
    $('galleryTitle').textContent=config.title||'Wine & Canvas Toledo Painting Portfolio';
    $('gallerySubtitle').textContent=config.subtitle||'Find a painting you love.';
    bind();
    await loadPage();
  }catch(error){
    $('loadingIndicator').hidden=true;
    $('errorMessage').textContent=error.message||'Unable to start the portfolio.';
    $('errorMessage').hidden=false;
  }
}
init();
