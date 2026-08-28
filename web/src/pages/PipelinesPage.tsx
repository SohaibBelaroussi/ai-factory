import { PageHeader, Empty } from '../components/ui';

export default function PipelinesPage(): React.ReactNode {
  return (
    <div>
      <PageHeader title="Pipelines" />
      <Empty>pipelines — next milestone</Empty>
    </div>
  );
}
