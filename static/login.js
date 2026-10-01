// 登录表单：提交、错误抖动、密码可见切换、提交中状态；登录成功携 hash 回深链。
const form = document.querySelector('#login-form'), pw = document.querySelector('#password'),
  field = document.querySelector('.pw-field'), error = document.querySelector('#login-error'),
  button = form.querySelector('button.primary'), spinner = button.querySelector('.spinner'),
  btnText = button.querySelector('.btn-text'), toggle = document.querySelector('.pw-toggle');

toggle.addEventListener('click', () => {
  const show = pw.type === 'password';
  pw.type = show ? 'text' : 'password';
  toggle.querySelector('.ico-show').hidden = show;
  toggle.querySelector('.ico-hide').hidden = !show;
  toggle.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
  toggle.setAttribute('aria-pressed', String(show));
  pw.focus();
});

// 重新输入时清掉上一轮的错误与抖动
pw.addEventListener('input', () => { error.textContent = ''; field.classList.remove('shake'); });

form.addEventListener('submit', async e => {
  e.preventDefault();
  button.disabled = true; button.classList.add('loading'); button.setAttribute('aria-busy', 'true');
  spinner.hidden = false; btnText.hidden = true; error.textContent = '';
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw.value }) });
    const d = await r.json();
    if (!r.ok) throw Error(d.error);
    location.replace('/' + location.hash);
  } catch (e) {
    error.textContent = e.message || '暂时无法连接，请重试';
    field.classList.remove('shake'); void field.offsetWidth; field.classList.add('shake');
  } finally {
    button.disabled = false; button.classList.remove('loading'); button.removeAttribute('aria-busy');
    spinner.hidden = true; btnText.hidden = false;
  }
});
