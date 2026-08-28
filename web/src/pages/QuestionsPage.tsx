import { PageHeader, Empty } from '../components/ui';

export default function QuestionsPage(): React.ReactNode {
  return (
    <div>
      <PageHeader title="Questions & Notifications" />
      <Empty>questions — next milestone</Empty>
    </div>
  );
}
