/**
 * The startup and error screen: the pug, one line of status and, while starting, a little run. The pug hops toward
 * a bone, slowing as it nears it without ever arriving, since startup time is unknown; when the app is ready,
 * window.pugportReady() lets it dash and grab the bone (a quarter of a second) before the app opens.
 */
export function splashHtml(message: string, failed = false, logo = ''): string {
  const escaped = message.replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
  const pug = logo ? `<img src="${logo}" alt="">` : '';
  const bone =
    '<svg class="bone" viewBox="0 0 24 24"><path transform="rotate(-35 12 12)" d="M7.2 9.6C6.6 8.1 5.1 7.4 3.8 8 2.4 8.6 2.1 10.3 3 11.3 1.9 11.9 1.7 13.5 2.6 14.4 3.7 15.5 5.6 15.1 6.3 13.9L17.7 13.9C18.4 15.1 20.3 15.5 21.4 14.4 22.3 13.5 22.1 11.9 21 11.3 21.9 10.3 21.6 8.6 20.2 8 18.9 7.4 17.4 8.1 16.8 9.6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>PugPort</title><style>
html,body{height:100%;margin:0;overflow:hidden;background:#121316;color:#EDEDEF;font-family:"Segoe UI Variable Display","Segoe UI","Microsoft YaHei UI",sans-serif;-webkit-user-select:none;user-select:none}
main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;animation:in .4s ease-out}
@keyframes in{from{opacity:0;transform:translateY(4px)}}
h1{margin:0;font-size:20px;font-weight:600;letter-spacing:.2px}
p{margin:0;font-size:13px;color:${failed ? '#F87171' : '#8B8B92'};max-width:520px;text-align:center;line-height:1.6}
.scene{position:relative;width:220px;height:62px}
.ground{position:absolute;left:0;right:0;bottom:6px;height:1px;background:linear-gradient(90deg,transparent,#2A2A2F 12%,#2A2A2F 88%,transparent)}
.pug{position:absolute;left:0;bottom:6px;width:46px;height:46px;will-change:transform}
.pug img{display:block;width:100%;height:100%;transform-origin:50% 100%;animation:hop .28s ease-in-out infinite alternate}
@keyframes hop{from{transform:translateY(0) rotate(-4deg)}to{transform:translateY(-7px) rotate(4deg)}}
.bone{position:absolute;right:0;bottom:7px;z-index:2;width:30px;height:30px;color:#EDEDEF;transition:transform .14s ease-out}
.got .pug img{animation:none;transform:translateY(-6px)}
.got .bone{transform:translate(-12px,-1px) rotate(35deg) scale(1.5)}
.still{width:56px;height:56px}.still img{width:100%;height:100%;${failed ? 'filter:grayscale(1);opacity:.7' : ''}}
@media (prefers-color-scheme:light){html,body{background:#F3F3F5;color:#1B1C20}p{color:${failed ? '#C43A3A' : '#5F6270'}}.bone{color:#1B1C20}.ground{background:linear-gradient(90deg,transparent,#DCDCE1 12%,#DCDCE1 88%,transparent)}}
@media (prefers-reduced-motion:reduce){.pug img{animation:none}}
</style><main>
${
  failed
    ? `<div class="still" aria-hidden="true">${pug}</div>`
    : `<div class="scene" aria-hidden="true"><div class="ground"></div>${bone}<div class="pug">${pug}</div></div>`
}
<h1>PugPort</h1><p>${escaped}</p>
</main>${
    failed
      ? ''
      : `<script>
const pug = document.querySelector('.pug');
const reach = 220 - 46 - 4;
const run = pug.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(' + reach * 0.85 + 'px)' }], {
  duration: 9000,
  easing: 'cubic-bezier(.2,.8,.3,1)',
  fill: 'forwards',
});
window.pugportReady = () =>
  new Promise((done) => {
    const from = new DOMMatrix(getComputedStyle(pug).transform).m41;
    run.cancel();
    const dash = pug.animate([{ transform: 'translateX(' + from + 'px)' }, { transform: 'translateX(' + reach + 'px)' }], {
      duration: Math.min(160, Math.max(80, (reach - from) * 1.2)),
      easing: 'ease-in',
      fill: 'forwards',
    });
    dash.onfinish = () => {
      document.body.classList.add('got');
      setTimeout(done, 120);
    };
  });
</script>`
  }</html>`;
}
