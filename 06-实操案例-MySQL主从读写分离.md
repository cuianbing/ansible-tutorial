# 第 6 篇 · 实操案例：MySQL 主从复制与读写分离

> **目标**：两台机器一键部署 **GTID 主从复制**：主库可写、从库只读、复制状态自动校验。这是"读写分离"架构的地基——复制通了之后，读流量如何分到从库（应用层还是代理层）本文末尾给出选型说明。

---

## 一、架构与原理

```text
                    ┌─── 写请求 ───▶ [node1] MySQL 主库 (可写)
   应用 ─────────────┤                     │ binlog(带GTID)
                    └─── 读请求 ───▶ [node2] MySQL 从库 (只读)
                                          ▲ 拉取并回放 binlog,与主库保持一致
```

复制的工作机制（理解了排错就不慌）：

1. 主库把变更写入 **binlog**（二进制日志）；
2. 从库的 **IO 线程**连到主库拉 binlog，落到本地 **relay log**（中继日志）；
3. 从库的 **SQL 线程**回放 relay log，追平数据；
4. **GTID** 给每个事务一个全局唯一编号，从库用它自动定位"该从哪继续"（`auto_position`），不再手工对齐 binlog 文件名和偏移量。

**读写分离在哪里实现？** 复制只解决"从库有数据"，"写走主库、读走从库"的分流发生在应用侧：

| 方案 | 形态 | 适用 |
| --- | --- | --- |
| 应用层 | ORM/框架配置多数据源（如 ShardingSphere-JDBC、Spring 多 DataSource） | Java 团队最常用，无额外组件 |
| 代理层 | 独立中间件 ProxySQL/MySQL Router，应用连它像连一个 MySQL | 多语言团队、不改代码 |
| 云产品 | RDS 自带只读实例+代理 | 用云数据库时 |

本篇交付**复制基础设施**（任何方案的前提），并给出健康检查；代理层进阶见第八节。

## 二、环境准备

inventory（注意分成两组，主从角色在 inventory 里就定死）：

```ini
[mysql_master]
node1 ansible_host=192.168.100.11 ansible_user=deploy mysql_server_id=1

[mysql_replica]
node2 ansible_host=192.168.100.12 ansible_user=deploy mysql_server_id=2
```

目录结构（模板改用 Jinja2，第 4 篇套路）：

```text
~/ansible-demo/
├── ansible.cfg / inventory.ini
├── vars/mysql.yml
├── templates/mysqld.cnf.j2
└── mysql-replication.yml
```

变量文件 `vars/mysql.yml`：

```yaml
mysql_packages: [mysql-server, mysql-client, python3-pymysql]
mysql_bind_address: "0.0.0.0"

# 复制账号
repl_user: repl
repl_password: "R3pl#2026"          # 生产: vault 变量
# 业务库与账号(两台都建,读才能查)
app_db: app_db
app_user: app
app_password: "App#2026Pwd"
```

## 三、配置模板（主从共用，差异由变量控制）

`templates/mysqld.cnf.j2`：

```ini
[mysqld]
bind-address        = {{ mysql_bind_address }}
# ★ 主从身份:同一集群内必须唯一(我们放在 inventory 的主机变量里)
server_id           = {{ mysql_server_id }}

# ★ GTID 复制三件套
gtid_mode           = ON
enforce_gtid_consistency = ON
log_bin             = mysql-bin
binlog_format       = ROW
binlog_expire_logs_seconds = 604800        # binlog 保留 7 天

# 从库中继日志
relay_log           = relay-bin
skip_name_resolve   = 1

character-set-server = utf8mb4
collation-server     = utf8mb4_unicode_ci
```

> 两个角色用同一份模板：主库的 `read_only` 不写进模板，而是部署后用模块动态设置（这样模板零角色分支）。

## 四、Playbook 全文

`mysql-replication.yml`：

```yaml
---
# ================= Play 1:两台都做 —— 安装 + 配置 + 启动 =================
- name: MySQL 主从通用初始化
  hosts: mysql_master:mysql_replica     # 两组并集
  become: true
  vars_files: [vars/mysql.yml]

  tasks:
    - name: 安装 MySQL 与依赖
      ansible.builtin.apt:
        name: "{{ mysql_packages }}"
        state: present
        update_cache: true

    - name: 下发主从配置
      ansible.builtin.template:
        src: templates/mysqld.cnf.j2
        dest: /etc/mysql/mysql.conf.d/99-ansible.cnf
        mode: "0644"
      notify: 重启 MySQL

    - name: 服务运行并自启
      ansible.builtin.service:
        name: mysql
        state: started
        enabled: true

    - name: 等待 3306 就绪
      ansible.builtin.wait_for: { port: 3306, timeout: 120 }

  handlers:
    - name: 重启 MySQL
      ansible.builtin.service: { name: mysql, state: restarted }

# ================= Play 2:主库 —— 业务初始化 + 复制账号 =================
- name: 配置主库
  hosts: mysql_master
  become: true
  vars_files: [vars/mysql.yml]

  tasks:
    - name: 建业务库
      community.mysql.mysql_db:
        name: "{{ app_db }}"
        encoding: utf8mb4
        state: present
        login_unix_socket: /var/run/mysqld/mysqld.sock

    - name: 建业务账号
      community.mysql.mysql_user:
        name: "{{ app_user }}"
        host: "192.168.100.%"
        password: "{{ app_password }}"
        priv: "{{ app_db }}.*:ALL"
        state: present
        login_unix_socket: /var/run/mysqld/mysqld.sock
      no_log: true

    - name: 创建复制专用账号(最小权限:REPLICATION SLAVE)
      community.mysql.mysql_user:
        name: "{{ repl_user }}"
        host: "%"                       # 也可限定从库网段,更安全
        password: "{{ repl_password }}"
        priv: "*.*:REPLICATION SLAVE"   # MySQL 8.4+ 写作 REPLICATION REPLICA
        state: present
        login_unix_socket: /var/run/mysqld/mysqld.sock
      no_log: true

# ================= Play 3:从库 —— 只读 + 挂上主库 + 启动复制 =================
- name: 配置从库
  hosts: mysql_replica
  become: true
  vars_files: [vars/mysql.yml]
  vars:
    # 主库地址从 inventory 组里推导,不需要手工维护
    master_ip: "{{ hostvars[groups['mysql_master'][0]].ansible_host }}"

  tasks:
    - name: 建业务库与账号(与主库一致,读查询才可用)
      community.mysql.mysql_db:
        name: "{{ app_db }}"
        encoding: utf8mb4
        state: present
        login_unix_socket: /var/run/mysqld/mysqld.sock

    - name: 建业务账号
      community.mysql.mysql_user:
        name: "{{ app_user }}"
        host: "192.168.100.%"
        password: "{{ app_password }}"
        priv: "{{ app_db }}.*:ALL"
        state: present
        login_unix_socket: /var/run/mysqld/mysqld.sock
      no_log: true

    - name: 设置只读(普通只读 + 超级只读)
      community.mysql.mysql_variables:
        variable: "{{ item }}"
        value: "ON"
        mode: global
        login_unix_socket: /var/run/mysqld/mysqld.sock
      loop: [read_only, super_read_only]

    - name: 指向主库(GTID 自动定位)
      community.mysql.mysql_replication:
        mode: changereplication          # MySQL 8.0.23+ 语法;旧版用 changeprimary
        primary_host: "{{ master_ip }}"
        primary_port: 3306
        primary_user: "{{ repl_user }}"
        primary_password: "{{ repl_password }}"
        primary_auto_position: true      # GTID auto position
        login_unix_socket: /var/run/mysqld/mysqld.sock
      no_log: true

    - name: 启动复制
      community.mysql.mysql_replication:
        mode: startreplica
        login_unix_socket: /var/run/mysqld/mysqld.sock

    - name: 查询复制状态
      community.mysql.mysql_replication:
        mode: getreplica
        login_unix_socket: /var/run/mysqld/mysqld.sock
      register: replica
      changed_when: false

    - name: 校验 IO/SQL 线程均为 Yes
      ansible.builtin.assert:
        that:
          - (replica.Slave_IO_Running | default(replica.Replica_IO_Running)) == 'Yes'
          - (replica.Slave_SQL_Running | default(replica.Replica_SQL_Running)) == 'Yes'
        success_msg: "✅ 主从复制已建立"
        fail_msg: "❌ 复制未启动,排查见本文第七节"
```

## 五、执行与验证

```bash
cd ~/ansible-demo
ansible-playbook mysql-replication.yml
# 期望:三个 PLAY 全绿,从库 assert 通过
```

**验证 1：复制状态**（从库上手工复核）：

```bash
mysql -e "SHOW REPLICA STATUS\G" | grep -E "Replica_IO_Running|Replica_SQL_Running|Seconds_Behind|Source_Host"
# 期望: Yes / Yes / 0 / 192.168.100.11
```

**验证 2：数据自动同步**——在主库写，从库应自动出现：

```bash
# 主库
ssh deploy@192.168.100.11 "mysql app_db -e 'CREATE TABLE t1(id INT PRIMARY KEY); INSERT INTO t1 VALUES(1);'"
sleep 2
# 从库(只读库可查不可写)
ssh deploy@192.168.100.12 "mysql app_db -e 'SELECT * FROM t1;'"
```

**验证 3：只读生效**——从库上尝试写会被拒绝：

```bash
ssh deploy@192.168.100.12 "mysql app_db -e 'INSERT INTO t1 VALUES(2);'"
# 期望报错: The MySQL server is running with the --super-read-only option
```

## 六、应用侧接入读写分离

复制就绪后，按团队技术栈二选一：

- **Java 应用层**（推荐起步）：Spring 配置主从两个 DataSource + ShardingSphere-JDBC 的读写分离规则（`write-datasource` 指主库、`read-datasource` 指从库），对代码几乎零侵入；
- **代理层**：部署 ProxySQL/MySQL Router，应用只连代理；代理自动把写发主库、读发从库。适合多语言/遗留系统。配置要点（ProxySQL 以 admin 端口 6032 操作）：登记主从节点、设置 hostgroup 读写分组、开启对用户的读写分离规则——细节见其官方文档，不在本篇展开。

无论哪种，都建议：**读多写少的报表/列表查询走从库；写事务与"读己之写"（写入后立刻要读）走主库**——后者若误读从库会读到旧数据（复制毫秒级延迟）。

## 七、常见问题（FAQ）

| 现象 | 原因与处理 |
| --- | --- |
| `Replica_IO_Running: Connecting` | 从库连不上主库：网络/3306 防火墙、`repl` 账号密码错、主库 `bind-address` 未开放。`SHOW REPLICA STATUS\G` 看 `Last_IO_Error` |
| `Replica_SQL_Running: No` | 回放报错（常见：从库手工建过同名表/主键冲突）。测试环境可 `STOP REPLICA; SET GLOBAL sql_replica_skip_counter=1; START REPLICA;` 跳一条——**生产请先分析错误** |
| 报错 `The replication slave thread is not initialized` 或提示用 SOURCE 语法 | MySQL 版本差异：8.0.22+ 用 `CHANGE REPLICATION SOURCE TO`（模块 `changereplication`），旧版用 `CHANGE MASTER TO`（模块 `changeprimary`） |
| 8.4 上 `REPLICATION SLAVE` 授权报错 | 8.4 起特权改名：`GRANT REPLICATION REPLICA ON *.* TO ...` |
| `server_id` 冲突 | 主从必须不同；检查 inventory 的 `mysql_server_id` |
| 复制账号密码错误 1045 | `no_log: true` 掩盖了失败；手工 `mysql -h 主库IP -u repl -p` 测试账号连通性 |
| `read_only` 改不动 | 目标库要用 `super_read_only`（本篇已同时设置）；注意 Ansible 里 `value: "ON"` 是字符串 |
| 重复执行 playbook 报错 | `changereplication` 对"已配置"的从库会报 changed 错误——可给该任务加 `failed_when: "'already' not in msg"` 类容错，或用 `changed_when` 判断 |

## 八、小结

- GTID 主从 = 主库开 `gtid_mode`/`log_bin` → 建复制账号（REPLICATION SLAVE）→ 从库 `changereplication + primary_auto_position` → `startreplica` → assert 双线程 Yes；
- 从库务必 `read_only + super_read_only`，防止误写打破一致性；
- 主库地址用 `hostvars[groups['mysql_master'][0]]` 从 inventory 推导，换 IP 只改清单；
- 读写分离的分流在应用层（ShardingSphere 等）或代理层（ProxySQL 等）实现，注意"读己之写"要回主库；
- 生产化清单：密码 Vault 化、半同步复制（`rpl_semi_sync`）、复制监控告警（`Seconds_Behind`）、定期备份。

下一篇部署第一类"分布式协调"中间件：三节点 ZooKeeper 集群。

---

*导航：[README](README.md) · 上一篇：[05-实操案例-单机MySQL](05-实操案例-单机MySQL.md) · 下一篇：[07-实操案例-ZooKeeper三节点集群](07-实操案例-ZooKeeper三节点集群.md)*
