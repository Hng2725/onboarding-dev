import {
  CheckCircleFilled,
  ClockCircleOutlined,
  FileDoneOutlined,
  RedoOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';

import type {
  EssayFeedbackRecord,
  EvaluationRecord,
  FinalConclusion,
  LearnerAssignmentDto,
  LearnerAttemptResultDto,
  MultipleChoiceScore,
} from '../../onboarding/contracts';
import type { PublishedReviewDto } from '../../onboarding/reviews';
import type { OnboardingApi } from './api';
import { EmptyState, ErrorState, LoadingState, StatusBadge, conclusionLabel } from './components';

export interface ResultPresentationInput {
  readonly mcScore?: MultipleChoiceScore | null;
  readonly essayFeedback?: readonly Pick<EssayFeedbackRecord, 'id'>[];
  readonly evaluation?: Pick<EvaluationRecord, 'conclusion'>;
}

export function resultPresentation(input: ResultPresentationInput) {
  const showScore = Boolean(input.mcScore && input.mcScore.totalCount > 0);
  const showFeedback = Boolean(input.evaluation);
  const conclusion = input.evaluation?.conclusion;
  return {
    showScore,
    ...(showScore ? { scoreLabel: `${Math.round(input.mcScore!.percentage)}%` } : {}),
    showFeedback,
    ...(conclusion ? { conclusionLabel: conclusionLabel(conclusion) } : {}),
    canRetry: conclusion === 'retry',
  };
}

interface ResultItem {
  readonly assignment: LearnerAssignmentDto;
  readonly result?: LearnerAttemptResultDto;
  readonly feedback: PublishedReviewDto;
}

function conclusionIcon(conclusion: FinalConclusion) {
  if (conclusion === 'retry') return <RedoOutlined />;
  if (conclusion === 'passed') return <TrophyOutlined />;
  return <FileDoneOutlined />;
}

export function ResultsPage({ api, onRetry }: { api: OnboardingApi; onRetry: (assignmentId: string) => void }) {
  const [items, setItems] = useState<readonly ResultItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.learning<{ assignments: readonly LearnerAssignmentDto[] }>('list');
      const next = await Promise.all(response.assignments.map(async (assignment): Promise<ResultItem> => {
        const [{ feedback }, resultResponse] = await Promise.all([
          api.learning<{ feedback: PublishedReviewDto }>('get_feedback', { assignmentId: assignment.id }),
          assignment.activeAttemptId
            ? api.learning<{ result: LearnerAttemptResultDto }>('get_result', { attemptId: assignment.activeAttemptId })
            : Promise.resolve(undefined),
        ]);
        return { assignment, feedback, result: resultResponse?.result };
      }));
      setItems(next.filter((item) => item.assignment.activeAttemptId || item.feedback.evaluation));
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('Không thể tải kết quả onboarding.'));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <LoadingState label="Đang tải kết quả của bạn…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!items.length) return <EmptyState title="Chưa có kết quả" description="Kết quả sẽ xuất hiện sau khi bạn nộp bài. Nhận xét chỉ hiển thị khi Admin đã công bố đánh giá." icon={<ClockCircleOutlined />} />;

  return <div className="page-stack">
    <section className="page-heading"><div><span className="section-kicker">KẾT QUẢ CỦA TÔI</span><h1>Điểm và đánh giá onboarding</h1><p>Điểm trắc nghiệm được chấm tự động. Kết luận và nhận xét được công bố bởi Admin.</p></div></section>
    <div className="results-list">{items.map(({ assignment, result, feedback }) => {
      const presentation = resultPresentation({ mcScore: result?.mcScore, essayFeedback: feedback.essayFeedback, evaluation: feedback.evaluation });
      const evaluation = presentation.showFeedback ? feedback.evaluation : undefined;
      return <article className="result-card" key={assignment.id}>
        <header><div><span className="assignment-type">{assignment.employeeType === 'advanced' ? 'Chuyên sâu' : 'Thông thường'}</span><h2>{assignment.templateTitle}</h2></div><StatusBadge status={assignment.status} /></header>
        <div className="result-summary">
          {presentation.showScore ? <div className="score-ring"><strong>{presentation.scoreLabel}</strong><span>Trắc nghiệm</span></div> : <div className="score-ring score-ring-empty"><FileDoneOutlined /><span>Không có điểm số</span></div>}
          {evaluation ? <div className={`conclusion-panel conclusion-${evaluation.conclusion}`}><span>{conclusionIcon(evaluation.conclusion)} Kết luận</span><strong>{presentation.conclusionLabel}</strong><small>{evaluation.completionLevel}</small></div> : <div className="pending-evaluation"><ClockCircleOutlined /><div><strong>Đang chờ Admin đánh giá</strong><span>Bài đã được ghi nhận. Nhận xét sẽ hiển thị sau khi công bố.</span></div></div>}
        </div>
        {evaluation && <div className="published-feedback"><div className="feedback-callout"><CheckCircleFilled /><p>{evaluation.publicComment}</p></div><div className="feedback-columns"><section><h3>Điểm mạnh</h3><p>{evaluation.strengths}</p></section><section><h3>Cần cải thiện</h3><p>{evaluation.improvements}</p></section></div>{feedback.essayFeedback.length > 0 && <section className="essay-feedback-list"><h3>Nhận xét phần tự luận</h3>{feedback.essayFeedback.map((item) => <article key={item.id}><FileDoneOutlined /><p>{item.comment}</p></article>)}</section>}</div>}
        {presentation.canRetry && <footer><button className="button button-primary" type="button" onClick={() => onRetry(assignment.id)}><RedoOutlined /> Làm lại chương trình</button></footer>}
      </article>;
    })}</div>
  </div>;
}
