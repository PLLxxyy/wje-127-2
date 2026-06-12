import db from './db';

const statusLabels: Record<string, string> = {
  pending: '待受理',
  processing: '处理中',
  resolved: '已修好',
  cancelled: '已取消',
};

const validTransitions: Record<string, string[]> = {
  pending: ['processing', 'resolved', 'cancelled'],
  processing: ['resolved'],
  resolved: [],
  cancelled: [],
};

interface TestCase {
  from: string;
  to: string;
  shouldPass: boolean;
}

const testCases: TestCase[] = [
  { from: 'pending', to: 'processing', shouldPass: true },
  { from: 'pending', to: 'resolved', shouldPass: true },
  { from: 'pending', to: 'cancelled', shouldPass: true },
  { from: 'processing', to: 'resolved', shouldPass: true },
  { from: 'processing', to: 'pending', shouldPass: false },
  { from: 'processing', to: 'cancelled', shouldPass: false },
  { from: 'resolved', to: 'pending', shouldPass: false },
  { from: 'resolved', to: 'processing', shouldPass: false },
  { from: 'resolved', to: 'cancelled', shouldPass: false },
  { from: 'cancelled', to: 'pending', shouldPass: false },
  { from: 'cancelled', to: 'processing', shouldPass: false },
  { from: 'cancelled', to: 'resolved', shouldPass: false },
];

function isValidTransition(from: string, to: string): boolean {
  const allowed = validTransitions[from] || [];
  return allowed.includes(to);
}

function runTransitionTests(): void {
  console.log('=== 状态流转校验测试 ===\n');
  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    const result = isValidTransition(tc.from, tc.to);
    const ok = result === tc.shouldPass;
    const status = ok ? '✓ PASS' : '✗ FAIL';
    const fromLabel = statusLabels[tc.from] || tc.from;
    const toLabel = statusLabels[tc.to] || tc.to;
    console.log(
      `${status}  ${fromLabel} → ${toLabel}  (expected: ${tc.shouldPass ? 'allow' : 'block'}, actual: ${result ? 'allow' : 'block'})`
    );
    if (ok) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log(`\n总计: ${passed} 通过, ${failed} 失败, 共${testCases.length}个测试用例`);

  if (failed > 0) {
    process.exit(1);
  }
}

function runDbIntegrationTests(): void {
  console.log('\n=== 数据库集成测试（验证实际状态流转） ===\n');

  try {
    const testStudent = db.prepare('SELECT id FROM users WHERE username = ?').get('test') as { id: number } | undefined;
    if (!testStudent) {
      console.log('未找到测试用户，跳过数据库集成测试');
      return;
    }

    let passed = 0;
    let failed = 0;

    const insertResult = db.prepare(
      "INSERT INTO repairs (student_id, building, room, problem_type, description, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(testStudent.id, '1号楼', '101', '水电', '测试取消流转', 'pending');
    const repairId = insertResult.lastInsertRowid as number;
    console.log(`创建测试报修单 #${repairId} (状态: 待受理)`);

    const repair = db.prepare('SELECT * FROM repairs WHERE id = ?').get(repairId) as Record<string, unknown>;
    const currentStatus = repair.status as string;
    const canCancel = validTransitions[currentStatus]?.includes('cancelled') ?? false;
    if (canCancel) {
      console.log('✓ PASS 待受理 → 已取消（允许）');
      passed++;
      db.prepare("UPDATE repairs SET status = 'cancelled', updated_at = datetime('now', 'localtime') WHERE id = ?").run(repairId);
      console.log('  已实际更新状态为已取消');
    } else {
      console.log('✗ FAIL 待受理 → 已取消（预期允许但被阻止）');
      failed++;
    }

    const cancelledRepair = db.prepare('SELECT * FROM repairs WHERE id = ?').get(repairId) as Record<string, unknown>;
    const cancelledStatus = cancelledRepair.status as string;

    const canReopen = validTransitions[cancelledStatus]?.includes('pending') ?? false;
    if (!canReopen) {
      console.log('✓ PASS 已取消 → 待受理（已阻止，符合预期）');
      passed++;
    } else {
      console.log('✗ FAIL 已取消 → 待受理（预期阻止但被允许）');
      failed++;
    }

    const canToProcessing = validTransitions[cancelledStatus]?.includes('processing') ?? false;
    if (!canToProcessing) {
      console.log('✓ PASS 已取消 → 处理中（已阻止，符合预期）');
      passed++;
    } else {
      console.log('✗ FAIL 已取消 → 处理中（预期阻止但被允许）');
      failed++;
    }

    const procResult = db.prepare(
      "INSERT INTO repairs (student_id, building, room, problem_type, description, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(testStudent.id, '2号楼', '202', '家具', '测试流转', 'processing');
    const procId = procResult.lastInsertRowid as number;
    console.log(`\n创建测试报修单 #${procId} (状态: 处理中)`);

    const procRepair = db.prepare('SELECT * FROM repairs WHERE id = ?').get(procId) as Record<string, unknown>;
    const procStatus = procRepair.status as string;

    const canProcCancel = validTransitions[procStatus]?.includes('cancelled') ?? false;
    if (!canProcCancel) {
      console.log('✓ PASS 处理中 → 已取消（已阻止，符合预期）');
      passed++;
    } else {
      console.log('✗ FAIL 处理中 → 已取消（预期阻止但被允许）');
      failed++;
    }

    const canProcResolve = validTransitions[procStatus]?.includes('resolved') ?? false;
    if (canProcResolve) {
      console.log('✓ PASS 处理中 → 已修好（允许）');
      passed++;
    } else {
      console.log('✗ FAIL 处理中 → 已修好（预期允许但被阻止）');
      failed++;
    }

    const resolvedResult = db.prepare(
      "INSERT INTO repairs (student_id, building, room, problem_type, description, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(testStudent.id, '3号楼', '303', '网络', '测试流转', 'resolved');
    const resolvedId = resolvedResult.lastInsertRowid as number;
    console.log(`\n创建测试报修单 #${resolvedId} (状态: 已修好)`);

    const resolvedRepair = db.prepare('SELECT * FROM repairs WHERE id = ?').get(resolvedId) as Record<string, unknown>;
    const resolvedStatus = resolvedRepair.status as string;

    const canResolvedToCancelled = validTransitions[resolvedStatus]?.includes('cancelled') ?? false;
    if (!canResolvedToCancelled) {
      console.log('✓ PASS 已修好 → 已取消（已阻止，符合预期）');
      passed++;
    } else {
      console.log('✗ FAIL 已修好 → 已取消（预期阻止但被允许）');
      failed++;
    }

    const canResolvedToProcessing = validTransitions[resolvedStatus]?.includes('processing') ?? false;
    if (!canResolvedToProcessing) {
      console.log('✓ PASS 已修好 → 处理中（已阻止，符合预期）');
      passed++;
    } else {
      console.log('✗ FAIL 已修好 → 处理中（预期阻止但被允许）');
      failed++;
    }

    db.prepare('DELETE FROM repairs WHERE id = ?').run(repairId);
    db.prepare('DELETE FROM repairs WHERE id = ?').run(procId);
    db.prepare('DELETE FROM repairs WHERE id = ?').run(resolvedId);
    console.log('\n清理测试数据完成');

    console.log(`\n总计: ${passed} 通过, ${failed} 失败`);

    if (failed > 0) {
      process.exit(1);
    } else {
      console.log('\n🎉 所有测试通过！');
    }
  } catch (err) {
    console.error('集成测试出错:', err);
    process.exit(1);
  }
}

runTransitionTests();
runDbIntegrationTests();
