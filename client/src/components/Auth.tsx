import { useEffect, useRef, useState } from 'preact/hooks';
import { Logo } from '../icons';
import { allowRegistration, signIn } from '../store';

export function Auth() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { if (matchMedia('(pointer: fine)').matches) first.current?.focus(); }, []);
  const reg = mode === 'register' && allowRegistration.value;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try { await signIn(reg ? 'register' : 'login', login, password, name); } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  return (
    <div class="auth">
      <form class="auth-card" onSubmit={submit}>
        <div class="auth-top">
          <Logo size={44} />
          <h1>Оникс</h1>
          <p>заметки в Markdown · свои и общие хранилища</p>
        </div>
        {allowRegistration.value ? (
          <div class="seg" role="tablist">
            <button type="button" class={`seg-btn${!reg ? ' is-active' : ''}`} onClick={() => { setMode('login'); setError(''); }}>Вход</button>
            <button type="button" class={`seg-btn${reg ? ' is-active' : ''}`} onClick={() => { setMode('register'); setError(''); }}>Регистрация</button>
          </div>
        ) : null}
        <label class="field">
          <span>Логин</span>
          <input ref={first} class="input" name="username" value={login} onInput={(e) => setLogin((e.target as HTMLInputElement).value)} required minLength={3} maxLength={32}
            autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck={false} />
        </label>
        {reg ? (
          <label class="field">
            <span>Имя (как вас видят другие)</span>
            <input class="input" name="name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} maxLength={60} autocomplete="name" placeholder="необязательно" />
          </label>
        ) : null}
        <label class="field">
          <span>Пароль</span>
          <input class="input" type="password" name="password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} required minLength={6}
            autocomplete={reg ? 'new-password' : 'current-password'} />
        </label>
        {error ? <div class="form-error" role="alert">{error}</div> : null}
        <button type="submit" class={`btn btn-primary btn-block${busy ? ' is-loading' : ''}`}>{reg ? 'Создать аккаунт' : 'Войти'}</button>
      </form>
    </div>
  );
}
