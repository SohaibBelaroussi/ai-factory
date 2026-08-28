import { PageHeader, Empty } from '../components/ui';

export default function BoardPage(): React.ReactNode {
  return (
    <div>
      <PageHeader title="Board" />
      <Empty>board — next milestone</Empty>
    </div>
  );
}
