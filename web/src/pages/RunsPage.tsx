import { PageHeader, Empty } from '../components/ui';

export default function RunsPage(): React.ReactNode {
  return (
    <div>
      <PageHeader title="Runs" />
      <Empty>runs — next milestone</Empty>
    </div>
  );
}
