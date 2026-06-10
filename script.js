(function () {
  const canvas  = document.getElementById('energy-canvas');
  const header  = canvas.parentElement;
  const nameEl  = document.getElementById('h-name');
  const accSpan = nameEl.querySelector('.acc');

  /* ── timing ─────────────────────────────────────────────── */
  const ORBIT_DUR     = 2800;
  const MS_PER_PX     = 4.2;   // ms per edge pixel — controls trace speed
  const HOLD_DUR      = 10000;
  const FADE_DUR      = 900;
  const PAUSE_DUR     = 500;

  /* ── colours ─────────────────────────────────────────────── */
  const GREEN      = { r: 80,  g: 210, b: 130 };
  const ORANGE     = { r: 232, g: 100, b: 20  };
  const ORANGE_CSS = 'rgb(232,100,20)';
  const GREEN_CSS  = 'rgb(80,210,130)';
  const FILL_CSS   = '#ffffff';

  /* hide native text — canvas redraws it */
  nameEl.style.color = 'transparent';
  if (accSpan) accSpan.style.color = 'transparent';

  /* ── helpers ─────────────────────────────────────────────── */
  function lerp(a,b,t){ return a+(b-a)*t; }
  function lerpC(a,b,t){
    return{r:Math.round(lerp(a.r,b.r,t)),g:Math.round(lerp(a.g,b.g,t)),b:Math.round(lerp(a.b,b.b,t))};
  }

  function dot(ctx,x,y,col,alpha){
    if(alpha<=0)return;
    ctx.save(); ctx.globalAlpha=alpha;
    ctx.fillStyle=`rgb(${col.r},${col.g},${col.b})`;
    ctx.beginPath(); ctx.arc(x,y,2,0,Math.PI*2); ctx.fill(); ctx.restore();
  }

  function drawRing(ctx,cx,cy,r){
    ctx.save(); ctx.strokeStyle='rgba(45,128,80,0.09)'; ctx.lineWidth=1; ctx.setLineDash([3,9]);
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.stroke(); ctx.setLineDash([]); ctx.restore();
  }

  /* ── extract ordered edge pixels from a glyph ───────────── */
  /* Returns points as {rx, ry} offsets from the glyph's
     (left-edge, top-of-cap) corner in display pixels.           */
  function extractEdgePoints(ch, displayFont, displayFontSize, displayH) {
    const SCALE = 4;
    const SZ    = Math.ceil(displayFontSize * 2 * SCALE); // generous canvas
    const off   = document.createElement('canvas');
    off.width   = SZ;
    off.height  = Math.ceil(displayH * SCALE * 1.4);
    const oc    = off.getContext('2d');
    const OW = off.width, OH = off.height;

    /* draw glyph at scaled size, baseline at 80% of display height × SCALE */
    const scaledFont = `900 ${displayFontSize * SCALE}px ${displayFont}`;
    oc.fillStyle = '#000'; oc.fillRect(0,0,OW,OH);
    oc.font = scaledFont;
    oc.textBaseline = 'alphabetic';
    oc.textAlign    = 'left';
    oc.fillStyle    = '#fff';
    const baselineY = displayH * SCALE * 0.80;
    oc.fillText(ch, 0, baselineY);

    const imgd = oc.getImageData(0,0,OW,OH);
    const data = imgd.data;

    function px(x,y){ if(x<0||y<0||x>=OW||y>=OH)return 0; return data[(y*OW+x)*4]; }
    function isEdge(x,y){
      if(!px(x,y))return false;
      const n8=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
      for(const[dx,dy]of n8){ if(!px(x+dx,y+dy))return true; }
      return false;
    }

    /* find bounding box of lit pixels to crop */
    let minX=OW,minY=OH,maxX=0,maxY=0;
    const edgePts=[];
    for(let y=0;y<OH;y++){
      for(let x=0;x<OW;x++){
        if(isEdge(x,y)){
          edgePts.push({x,y});
          if(x<minX)minX=x; if(x>maxX)maxX=x;
          if(y<minY)minY=y; if(y>maxY)maxY=y;
        }
      }
    }
    if(!edgePts.length) return {pts:[], offX:0, offY:0};

    /* greedy nearest-neighbour ordering */
    edgePts.sort((a,b)=>a.y!==b.y?a.y-b.y:a.x-b.x);
    const remaining=new Set(edgePts.map(p=>p.y*OW+p.x));
    const ordered=[]; let cur=edgePts[0];
    remaining.delete(cur.y*OW+cur.x); ordered.push(cur);

    const SR=3;
    while(remaining.size){
      let best=null,bestD=Infinity;
      for(let dy=-SR;dy<=SR;dy++){
        for(let dx=-SR;dx<=SR;dx++){
          const key=(cur.y+dy)*OW+(cur.x+dx);
          if(remaining.has(key)){
            const d=dx*dx+dy*dy;
            if(d<bestD){bestD=d;best={x:cur.x+dx,y:cur.y+dy};}
          }
        }
      }
      if(!best){
        let gBest=null,gD=Infinity;
        for(const key of remaining){
          const rx=key%OW,ry=Math.floor(key/OW);
          const d=(rx-cur.x)**2+(ry-cur.y)**2;
          if(d<gD){gD=d;gBest={x:rx,y:ry};}
        }
        best=gBest;
      }
      remaining.delete(best.y*OW+best.x);
      ordered.push(best); cur=best;
    }

    /* convert to display-pixel offsets from glyph top-left corner (minX,minY) */
    const inv=1/SCALE;
    const result=[]; let lx=-999,ly=-999;
    for(const p of ordered){
      const rx=(p.x-minX)*inv, ry=(p.y-minY)*inv;
      if(Math.hypot(rx-lx,ry-ly)>=0.85){
        result.push({rx,ry}); lx=rx; ly=ry;
      }
    }
    /* offsets from glyph bbox top-left to display position (tx, glyphTop) */
    return { pts: result, glyphW:(maxX-minX)*inv, glyphH:(maxY-minY)*inv };
  }

  /* ── build letter data with edge point arrays ────────────── */
  let _letters=null, _layoutTS=0;

  function buildLetters(){
    const hR    = header.getBoundingClientRect();
    const nR    = nameEl.getBoundingClientRect();
    const style = window.getComputedStyle(nameEl);
    const fsz   = style.fontSize;
    const fam   = style.fontFamily;
    const font  = `900 ${fsz} ${fam}`;

    const oc = document.createElement('canvas').getContext('2d');
    oc.font  = font;

    const fullText = nameEl.textContent;
    const accText  = accSpan ? accSpan.textContent : '';
    const accStart = accSpan ? fullText.indexOf(accText) : -1;

    const ox       = nR.left - hR.left;
    const oy       = nR.top  - hR.top;
    const nh       = nR.height;
    const baseline = oy + nh * 0.80;

    const letters = [];
    let curX = 0;
    for(let i=0;i<fullText.length;i++){
      const ch = fullText[i];
      const w  = oc.measureText(ch).width;
      if(ch !== ' '){
        const isAcc = accStart>=0 && i>=accStart && i<accStart+accText.length;
        const colour = isAcc ? ORANGE_CSS : GREEN_CSS;

        /* extract edge points at display font size, offset to exact letter position */
        const fsizePx = parseFloat(fsz);
        const { pts: rawPts, glyphW, glyphH } = extractEdgePoints(ch, fam, fsizePx, nh);

        /* anchor: glyph bbox top-left aligns with (tx, glyphTop)
           glyphTop = baseline − ascent ≈ oy (top of nameEl bounding box)           */
        const glyphTop = oy;
        const pts = rawPts.map(p=>({ x: ox+curX+p.rx, y: glyphTop+p.ry }));

        letters.push({
          ch, font,
          tx: ox+curX, ty: baseline,
          color: colour,
          dotCol: isAcc ? ORANGE : ORANGE,
          isAcc,
          pts,
          dur: Math.max(600, pts.length * MS_PER_PX)
        });
      }
      curX += w;
    }
    return letters;
  }

  function getLayout(ts){
    const aw = document.querySelector('.avatar-wrap');
    if(!aw) return null;
    const hR = header.getBoundingClientRect();
    const aR = aw.getBoundingClientRect();
    if(!_letters || ts-_layoutTS>1500){ _letters=buildLetters(); _layoutTS=ts; }
    return{
      cx: aR.left-hR.left+aR.width/2,
      cy: aR.top-hR.top+aR.height/2,
      r:  aR.width/2+9,
      letters: _letters
    };
  }

  /* ── draw a fully-revealed letter ───────────────────────── */
  function drawLetter(ctx, l, alpha){
    if(alpha<=0) return;
    ctx.save(); ctx.globalAlpha=alpha;
    ctx.font=l.font; ctx.textBaseline='alphabetic';
    ctx.fillStyle=FILL_CSS;  ctx.fillText(l.ch,l.tx,l.ty);
    ctx.strokeStyle=l.color; ctx.lineWidth=1.4; ctx.lineJoin='round';
    ctx.strokeText(l.ch,l.tx,l.ty);
    ctx.restore();
  }

  /* draw revealed portion of current letter using edge trail */
  function drawPartialLetter(ctx, l, progress){
    /* first draw the full letter fill (white) to cover native text */
    ctx.save();
    ctx.font=l.font; ctx.textBaseline='alphabetic';
    ctx.fillStyle=FILL_CSS; ctx.fillText(l.ch,l.tx,l.ty);
    ctx.restore();

    if(!l.pts.length) return;
    const count = Math.floor(progress * l.pts.length);
    if(count<2) return;

    /* draw the traced edge so far as a coloured polyline */
    ctx.save();
    ctx.strokeStyle = l.color;
    ctx.lineWidth   = 1.6;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(l.pts[0].x, l.pts[0].y);
    for(let i=1;i<count;i++) ctx.lineTo(l.pts[i].x, l.pts[i].y);
    ctx.stroke();
    ctx.restore();
  }

  function drawLetters(ctx, letters, count, alpha){
    for(let i=0;i<count;i++) drawLetter(ctx,letters[i],alpha);
  }

  /* ── state machine ──────────────────────────────────────── */
  let phase='orbit', phaseStart=null, letterIdx=0, revealedCount=0;

  function resize(){
    _letters=null;
    const dpr=window.devicePixelRatio||1;
    const rect=header.getBoundingClientRect();
    canvas.width=rect.width*dpr; canvas.height=rect.height*dpr;
    canvas.style.width=rect.width+'px'; canvas.style.height=rect.height+'px';
    canvas.getContext('2d').scale(dpr,dpr);
  }

  function frame(ts){
    if(!phaseStart) phaseStart=ts;
    const elapsed=ts-phaseStart;
    const dpr=window.devicePixelRatio||1;
    const ctx=canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width/dpr,canvas.height/dpr);

    const L=getLayout(ts);
    if(!L){requestAnimationFrame(frame);return;}
    const{cx,cy,r,letters}=L;
    drawRing(ctx,cx,cy,r);

    /* ORBIT */
    if(phase==='orbit'){
      const t=Math.min(elapsed/ORBIT_DUR,1);
      const angle=-Math.PI/2+t*Math.PI*2;
      dot(ctx,cx+r*Math.cos(angle),cy+r*Math.sin(angle),
          t<0.75?GREEN:lerpC(GREEN,ORANGE,(t-0.75)/0.25),1);
      if(elapsed>=ORBIT_DUR){phase='name';phaseStart=ts;letterIdx=0;revealedCount=0;}

    /* NAME */
    } else if(phase==='name'){
      drawLetters(ctx,letters,revealedCount,1);
      if(letterIdx>=letters.length){phase='hold';phaseStart=ts;requestAnimationFrame(frame);return;}

      const ltr=letters[letterIdx];
      const dur=ltr.dur||1000;
      const t=Math.min(elapsed/dur,1);

      drawPartialLetter(ctx,ltr,t);

      /* dot at current edge point */
      if(ltr.pts.length){
        const idx=Math.min(Math.floor(t*ltr.pts.length),ltr.pts.length-1);
        const p=ltr.pts[idx];
        dot(ctx,p.x,p.y,ORANGE,1);
      }

      if(elapsed>=dur){revealedCount=letterIdx+1;letterIdx++;phaseStart=ts;}

    /* HOLD */
    } else if(phase==='hold'){
      drawLetters(ctx,letters,letters.length,1);
      if(elapsed>=HOLD_DUR){phase='fadeout';phaseStart=ts;}

    /* FADEOUT */
    } else if(phase==='fadeout'){
      const a=Math.max(0,1-elapsed/FADE_DUR);
      drawLetters(ctx,letters,letters.length,a);
      if(elapsed>=FADE_DUR){phase='pause';phaseStart=ts;}

    /* PAUSE */
    } else {
      if(elapsed>=PAUSE_DUR){phase='orbit';phaseStart=ts;}
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize',resize);
  /* wait 600ms for Orbitron to load before first measurement + edge extraction */
  setTimeout(()=>{resize();requestAnimationFrame(frame);},600);
})();