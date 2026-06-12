import http from 'http';
import app from './index';
import db from './db';

const PORT = 3099;

function request(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    if (token) {
      options.headers!['Authorization'] = `Bearer ${token}`;
    }
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode || 0, data: parsed });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function post(path: string, body: unknown, token?: string) {
  return request('POST', path, body, token);
}

function put(path: string, body: unknown, token: string) {
  return request('PUT', path, body, token);
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS  ${label}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function runTests() {
  const server = app.listen(PORT, '127.0.0.1');

  await new Promise<void>((resolve) => {
    server.on('listening', resolve);
  });

  console.log('=== API 集成测试：状态流转校验 ===\n');

  try {
    console.log('1. 登录获取 admin token...');
    const loginRes = await post('/api/auth/login', { username: 'admin', password: '123456' });
    assert(loginRes.status === 200, '管理员登录成功');
    const adminToken = (loginRes.data as { token: string }).token;

    const studentLoginRes = await post('/api/auth/login', { username: 'test', password: '123456' });
    assert(studentLoginRes.status === 200, '学生登录成功');
    const studentToken = (studentLoginRes.data as { token: string }).token;

    const testStudent = db.prepare("SELECT id FROM users WHERE username = ?").get('test') as { id: number } | undefined;
    if (!testStudent) throw new Error('测试用户不存在');

    console.log('\n2. 创建待受理报修单...');
    const pendingRes = await post('/api/repairs', {
      building: '1号楼', room: '301', problem_type: '水电', description: '测试取消-待受理',
    }, studentToken);
    assert(pendingRes.status === 200, '创建待受理报修单成功');
    const pendingId = ((pendingRes.data as { repair: { id: number } }).repair).id;

    console.log('\n3. 测试：待受理 → 已取消（应允许，200）');
    const cancelPendingRes = await put(`/api/admin/repairs/${pendingId}`, { status: 'cancelled' }, adminToken);
    assert(cancelPendingRes.status === 200, '待受理 → 已取消 返回200');
    const cancelPendingData = cancelPendingRes.data as { repair: { status: string } };
    assert(cancelPendingData.repair.status === 'cancelled', '状态确实变为 cancelled');

    console.log('\n4. 测试：已取消 → 待受理（应拒绝，400）');
    const reopenRes = await put(`/api/admin/repairs/${pendingId}`, { status: 'pending' }, adminToken);
    assert(reopenRes.status === 400, '已取消 → 待受理 返回400');
    const reopenData = reopenRes.data as { error: string };
    assert(reopenData.error.includes('状态不合法'), '错误信息包含"状态不合法"');

    console.log('\n5. 测试：已取消 → 处理中（应拒绝，400）');
    const cancelToProcRes = await put(`/api/admin/repairs/${pendingId}`, { status: 'processing' }, adminToken);
    assert(cancelToProcRes.status === 400, '已取消 → 处理中 返回400');

    console.log('\n6. 创建处理中的报修单...');
    const procInsert = db.prepare(
      "INSERT INTO repairs (student_id, building, room, problem_type, description, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(testStudent.id, '1号楼', '302', '家具', '测试取消-处理中', 'processing');
    const processingId = procInsert.lastInsertRowid as number;

    console.log('\n7. 测试：处理中 → 已取消（应拒绝，400）');
    const cancelProcRes = await put(`/api/admin/repairs/${processingId}`, { status: 'cancelled' }, adminToken);
    assert(cancelProcRes.status === 400, '处理中 → 已取消 返回400');
    const cancelProcData = cancelProcRes.data as { error: string };
    assert(cancelProcData.error.includes('处理中') && cancelProcData.error.includes('已取消'), '错误信息指明从处理中到已取消不合法');

    console.log('\n8. 测试：处理中 → 已修好（应允许，200）');
    const resolveProcRes = await put(`/api/admin/repairs/${processingId}`, { status: 'resolved' }, adminToken);
    assert(resolveProcRes.status === 200, '处理中 → 已修好 返回200');
    const resolveProcData = resolveProcRes.data as { repair: { status: string } };
    assert(resolveProcData.repair.status === 'resolved', '状态确实变为 resolved');

    console.log('\n9. 创建已修好的报修单...');
    const resolvedInsert = db.prepare(
      "INSERT INTO repairs (student_id, building, room, problem_type, description, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(testStudent.id, '1号楼', '303', '网络', '测试取消-已修好', 'resolved');
    const resolvedId = resolvedInsert.lastInsertRowid as number;

    console.log('\n10. 测试：已修好 → 已取消（应拒绝，400）');
    const cancelResolvedRes = await put(`/api/admin/repairs/${resolvedId}`, { status: 'cancelled' }, adminToken);
    assert(cancelResolvedRes.status === 400, '已修好 → 已取消 返回400');
    const cancelResolvedData = cancelResolvedRes.data as { error: string };
    assert(cancelResolvedData.error.includes('已修好') && cancelResolvedData.error.includes('已取消'), '错误信息指明从已修好到已取消不合法');

    console.log('\n11. 测试：已修好 → 待受理（应拒绝，400）');
    const resolvedToPendingRes = await put(`/api/admin/repairs/${resolvedId}`, { status: 'pending' }, adminToken);
    assert(resolvedToPendingRes.status === 400, '已修好 → 待受理 返回400');

    console.log('\n12. 测试：待受理 → 处理中（应允许，200）');
    const newPendingInsert = db.prepare(
      "INSERT INTO repairs (student_id, building, room, problem_type, description, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(testStudent.id, '1号楼', '304', '水电', '测试-待受理到处理中', 'pending');
    const newPendingId = newPendingInsert.lastInsertRowid as number;
    const pendToProcRes = await put(`/api/admin/repairs/${newPendingId}`, { status: 'processing' }, adminToken);
    assert(pendToProcRes.status === 200, '待受理 → 处理中 返回200');

    console.log('\n13. 测试学生取消接口：待受理报修单取消（应允许，200）');
    const stuPendingInsert = db.prepare(
      "INSERT INTO repairs (student_id, building, room, problem_type, description, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(testStudent.id, '1号楼', '305', '水电', '测试学生取消', 'pending');
    const stuPendingId = stuPendingInsert.lastInsertRowid as number;
    const stuCancelRes = await put(`/api/repairs/${stuPendingId}/cancel`, {}, studentToken);
    assert(stuCancelRes.status === 200, '学生取消待受理报修单 返回200');
    const stuCancelData = stuCancelRes.data as { repair: { status: string } };
    assert(stuCancelData.repair.status === 'cancelled', '学生取消后状态确实变为 cancelled');

    console.log('\n14. 测试学生取消接口：处理中报修单取消（应拒绝，400）');
    const stuProcInsert = db.prepare(
      "INSERT INTO repairs (student_id, building, room, problem_type, description, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(testStudent.id, '1号楼', '306', '家具', '测试学生取消-处理中', 'processing');
    const stuProcId = stuProcInsert.lastInsertRowid as number;
    const stuCancelProcRes = await put(`/api/repairs/${stuProcId}/cancel`, {}, studentToken);
    assert(stuCancelProcRes.status === 400, '学生取消处理中报修单 返回400');
    const stuCancelProcData = stuCancelProcRes.data as { error: string };
    assert(stuCancelProcData.error.includes('待受理'), '错误信息提示仅待受理可取消');

    db.prepare('DELETE FROM repairs WHERE id = ?').run(pendingId);
    db.prepare('DELETE FROM repairs WHERE id = ?').run(processingId);
    db.prepare('DELETE FROM repairs WHERE id = ?').run(resolvedId);
    db.prepare('DELETE FROM repairs WHERE id = ?').run(newPendingId);
    db.prepare('DELETE FROM repairs WHERE id = ?').run(stuPendingId);
    db.prepare('DELETE FROM repairs WHERE id = ?').run(stuProcId);
    console.log('\n清理测试数据完成');

    console.log(`\n========== 测试结果 ==========`);
    console.log(`通过: ${passed}  失败: ${failed}  总计: ${passed + failed}`);

    if (failed > 0) {
      console.log('\n❌ 有测试未通过！');
      process.exit(1);
    } else {
      console.log('\n🎉 所有测试通过！');
    }
  } catch (err) {
    console.error('测试执行出错:', err);
    process.exit(1);
  } finally {
    server.close();
  }
}

runTests();
