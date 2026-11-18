import { currentLocale } from './i18n';
import { useEffect, useState, type ReactNode } from 'react';
import { Check, Loader2, Sparkles, Stethoscope, X } from 'lucide-react';
import type { Api, Notice } from './Workspace';
import { fictionContext } from '../shared/fiction';
import { shownName, withNames } from './i18n';
import type { AppState, Conversation, Project, TasteCandidate, TasteTest, WritingTopic } from '../shared/types';

type Notify = (notice: Notice) => void;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const topicLabels: Record<WritingTopic, string> = { prose: '正文', adult: '成人内容' };

/**
 * A blind taste test above the composer: while the samples are written, how far each got; then the passages by
 * letter only, a pick with an optional reason, and after the pick who wrote which.
 */
export function TasteTestCard({
  test,
  project,
  api,
  notify,
  onClose,
  onUseWriter,
}: {
  test: TasteTest;
  /** The test's project, to tell whether the pick became its default writer. */
  project?: Project;
  api: Api;
  notify: Notify;
  onClose: () => void;
  /** Hands the next message to the chosen writer (executor, model and effort in the composer). */
  onUseWriter?: (candidate: TasteCandidate) => void;
}) {
  const [reason, setReason] = useState('');
  // What a pick means: the best of these but still not good enough, or good enough; only then may it become default.
  const [verdict, setVerdict] = useState<'better' | 'good'>('better');
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const topic = topicLabels[test.topic];
  async function act(path: string, body: unknown) {
    setBusy(true);
    try {
      await api(path, body);
    } catch (error) {
      notify({ tone: 'error', message: errorText(error) });
    } finally {
      setBusy(false);
    }
  }
  const dismiss = (stopAuto = false) => void act(`/api/taste-tests/${test.id}/dismiss`, { stopAuto });
  const heading = (title: ReactNode, detail: string, close: () => void) => (
    <header className="taste-test-heading">
      <Sparkles size={15} aria-hidden="true" />
      <strong>{title}</strong>
      <small>{detail}</small>
      <button type="button" className="icon-button" aria-label="关闭试写对比" disabled={busy} onClick={close}>
        <X size={14} />
      </button>
    </header>
  );
  if (test.status === 'writing')
    return (
      <section className="taste-test" aria-label="试写对比">
        {heading(`试写对比 · ${topic}`, '几个模型正在各写一段，写好后请你盲选', () => dismiss())}
        <div className="taste-test-progress">
          {test.candidates.map((candidate) => (
            <span key={candidate.key} className={`taste-test-chip ${candidate.status}`}>
              {candidate.status === 'writing' ? <Loader2 size={12} className="spinning" /> : <Check size={12} />}
              {candidate.key} ·{' '}
              {candidate.status === 'writing' ? '在写' : candidate.status === 'done' ? '写好了' : '没写成'}
            </span>
          ))}
        </div>
      </section>
    );
  if (test.status === 'failed')
    return (
      <section className="taste-test" aria-label="试写对比">
        {heading(`试写对比 · ${topic}`, test.error ?? '这次没能完成试写。', () => dismiss())}
      </section>
    );
  if (test.status === 'chosen') {
    const chosen = test.candidates.find((candidate) => candidate.key === test.chosen);
    return (
      <section className="taste-test" aria-label="试写对比结果">
        {heading(
          <span translate="no">
            {withNames('你选了 {0}：{1}', [test.chosen ?? '', shownName(chosen?.label ?? '')])}
          </span>,
          test.verdict === 'good'
            ? project?.writingPreferences?.some((item) => item.testId === test.id)
              ? `这次满意，以后这个项目的${topic}默认交给它。`
              : '这次满意，没有设为默认写手。'
            : '这一组里它最好，但还不满意，没有记成偏好。',
          onClose,
        )}
        <ul className="taste-test-reveal">
          {test.candidates.map((candidate) => (
            <li key={candidate.key} className={candidate.key === test.chosen ? 'chosen' : ''}>
              <strong>{candidate.key}</strong> <span translate="no">{shownName(candidate.label)}</span>
              {candidate.status === 'failed' ? '（没写成）' : ''}
            </li>
          ))}
        </ul>
        {test.verdict === 'good' && chosen && onUseWriter && (
          <footer className="taste-test-actions">
            <button type="button" className="button primary tiny" onClick={() => onUseWriter(chosen)}>
              用它写下一条
            </button>
          </footer>
        )}
      </section>
    );
  }
  return (
    <section className="taste-test" aria-label="试写对比">
      {heading(
        `试写对比 · ${topic}：你更喜欢哪一段？`,
        '盲测：选完才揭晓是谁写的。只有你说满意并设为默认，才会记成这个项目的写作偏好。',
        () => dismiss(),
      )}
      <div className="taste-test-passages">
        {test.candidates.map((candidate) => (
          <article key={candidate.key} className={`taste-test-passage ${candidate.status}`}>
            <h4>{candidate.key}</h4>
            {candidate.status === 'done' ? (
              <>
                <div className="taste-test-text" translate="no">
                  {candidate
                    .text!.split(/\n+/)
                    .filter((line) => line.trim())
                    .map((line, index) => (
                      <p key={index}>{line}</p>
                    ))}
                </div>
                <button
                  type="button"
                  className="button primary tiny"
                  disabled={busy}
                  onClick={() =>
                    void act(`/api/taste-tests/${test.id}/choose`, {
                      key: candidate.key,
                      verdict,
                      makeDefault: verdict === 'good' && makeDefault,
                      ...(reason.trim() ? { reason: reason.trim() } : {}),
                    })
                  }
                >
                  选 {candidate.key}
                </button>
              </>
            ) : (
              <p className="taste-test-missing">这一段没写成。</p>
            )}
          </article>
        ))}
      </div>
      <fieldset className="taste-test-verdict">
        <label>
          <input type="radio" checked={verdict === 'better'} onChange={() => setVerdict('better')} />
          选中的那段相对最好，但还不满意
        </label>
        <label>
          <input type="radio" checked={verdict === 'good'} onChange={() => setVerdict('good')} />
          选中的那段满意
        </label>
        <label className={verdict === 'good' ? '' : 'disabled'}>
          <input
            type="checkbox"
            checked={verdict === 'good' && makeDefault}
            disabled={verdict !== 'good'}
            onChange={(event) => setMakeDefault(event.target.checked)}
          />
          {`以后这个项目的${topic}默认交给它`}
        </label>
      </fieldset>
      <textarea
        className="taste-test-reason"
        rows={2}
        maxLength={500}
        value={reason}
        placeholder="为什么选它，或别的几段哪里不好（可选）。只有设为默认时，这句话才会带进以后的写作。"
        onChange={(event) => setReason(event.target.value)}
      />
      <footer className="taste-test-actions">
        <button type="button" className="button secondary tiny" disabled={busy} onClick={() => dismiss()}>
          跳过这次
        </button>
        <button
          type="button"
          className="button secondary tiny"
          disabled={busy}
          title="关掉这一组，换别的模型或强度再写一组"
          onClick={() => void act(`/api/taste-tests/${test.id}/retry`, {})}
        >
          都不满意，换一批再试
        </button>
        <button type="button" className="button quiet tiny" disabled={busy} onClick={() => dismiss(true)}>
          都不喜欢，以后别自动试写
        </button>
      </footer>
    </section>
  );
}

/** The project's remembered writing preferences in the routing panel, with a manual taste test. */
export function WritingPreferences({
  conversation,
  state,
  api,
  notify,
}: {
  conversation: Conversation;
  state: AppState;
  api: Api;
  notify: Notify;
}) {
  const project = state.projects?.find((item) => item.id === conversation.projectId);
  const [topic, setTopic] = useState<WritingTopic>('prose');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<{ folder: string; chapters: number }[]>();
  const fiction = fictionContext(conversation, project);
  useEffect(() => {
    if (!project || !fiction || candidates) return;
    api<{ folder: string; chapters: number }[]>(`/api/projects/${project.id}/manuscript-candidates`, undefined, 'GET')
      .then(setCandidates)
      .catch(() => setCandidates([]));
  }, [project, fiction, candidates, api]);
  if (!project || !fiction) return null;
  const running = (state.tasteTests ?? []).some(
    (test) => test.projectId === project.id && (test.status === 'writing' || test.status === 'ready'),
  );
  async function act(path: string, body?: unknown, method?: 'DELETE' | 'PUT') {
    setBusy(true);
    try {
      await api(path, body, method);
      return true;
    } catch (error) {
      notify({ tone: 'error', message: errorText(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="writing-preferences" aria-label="写作偏好">
      <h3>正式正文</h3>
      <p className="panel-note">
        这本书现在的章节放在哪个文件夹。体检、写作和记忆都只认这一个，其他文件夹当作旧稿或废稿。
      </p>
      <select
        className="writing-manuscript"
        aria-label="正式正文文件夹"
        value={project.manuscript ?? ''}
        disabled={busy}
        onChange={(event) =>
          void act(`/api/projects/${project.id}/manuscript`, { path: event.target.value || null }, 'PUT')
        }
      >
        <option value="">{project.manuscript ? '不指定' : '还没选'}</option>
        {project.manuscript && !candidates?.some((item) => item.folder === project.manuscript) && (
          <option value={project.manuscript}>{project.manuscript}</option>
        )}
        {candidates?.map((item) => (
          <option key={item.folder} value={item.folder}>
            {item.folder.slice(project.path.length).replace(/^[\\/]/, '') || '项目根目录'}（{item.chapters} 章）
          </option>
        ))}
      </select>
      <h3>写作偏好（按项目记住）</h3>
      <p className="panel-note">
        规则没指定执行器的写作，会先让 3 个模型各写一段请你盲选，选中的模型、强度和你说的理由会记在这个项目里。
      </p>
      {(['prose', 'adult'] as const).map((item) => {
        const preference = project.writingPreferences?.find((value) => value.topic === item);
        return (
          <div className="writing-preference" key={item}>
            <span className="routing-topic">{topicLabels[item]}</span>
            {preference ? (
              <>
                <span className="writing-preference-choice">
                  <span translate="no">{shownName(preference.label)}</span>
                  <small>
                    {new Date(preference.chosenAt).toLocaleDateString(currentLocale())} 试写选出
                    {preference.reason && (
                      <>
                        {' · '}
                        <span translate="no">{preference.reason}</span>
                      </>
                    )}
                  </small>
                </span>
                <button
                  type="button"
                  className="button quiet tiny"
                  disabled={busy}
                  onClick={() =>
                    void act(`/api/projects/${project.id}/writing-preferences/${item}`, undefined, 'DELETE')
                  }
                >
                  清除
                </button>
              </>
            ) : (
              <span className="writing-preference-choice muted">还没试写过</span>
            )}
          </div>
        );
      })}
      <div className="writing-preference-test">
        <select value={topic} onChange={(event) => setTopic(event.target.value as WritingTopic)} aria-label="试写类型">
          <option value="prose">正文</option>
          <option value="adult">成人内容</option>
        </select>
        <textarea
          rows={2}
          value={brief}
          placeholder="试写什么？例如：写第三章开头，两人第一次在雨里碰面。"
          onChange={(event) => setBrief(event.target.value)}
        />
        <button
          type="button"
          className="button secondary"
          disabled={busy || running || !brief.trim()}
          title={running ? '已有一组试写在进行，先选完或跳过它' : undefined}
          onClick={async () => {
            if (await act('/api/taste-tests', { conversationId: conversation.id, topic, brief: brief.trim() }))
              setBrief('');
          }}
        >
          <Sparkles size={14} />
          开始试写对比
        </button>
      </div>
      <label className="routing-option">
        <input
          type="checkbox"
          checked={!project.tasteTestsOff}
          disabled={busy}
          onChange={(event) =>
            void act(`/api/projects/${project.id}/taste-tests-auto`, { enabled: event.target.checked })
          }
        />
        <span>遇到没定执行器的写作时自动试写（同类写作每天最多一次）</span>
      </label>
      <div className="writing-style-check">
        <h3>文风体检</h3>
        <p className="panel-note">
          按固定规则把项目里的章节全部数一遍：先否定再自己作答、单字成句、一连串短句、拿上一句尾巴开头、套话词和反复出现的同一句话。不花额度，结果发在对话里。
        </p>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void act(`/api/conversations/${conversation.id}/style-check`, {})}
        >
          <Stethoscope size={14} />
          全书文风体检
        </button>
      </div>
    </section>
  );
}
