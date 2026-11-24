# 第 5 篇 · 实操案例：Ansible 部署单机 MySQL

> **目标**：一条命令，在一台全新的 Ubuntu 服务器上完成 MySQL 8 的安装、配置、建库、建用户、远程访问与验证。这也是你第一个"生产可用"的 Playbook——照此结构可替换为任何软件的部署。

---

## 一、目标与拓扑

```text
控制节点(你的电脑/WSL2)
      │  ansible-playbook mysql-standalone.yml
      ▼
[node1] 192.168.100.11   ← Ubuntu 22.04, 装 MySQL 8.0 单机
        端口 3306 对内网开放
```

完成后你将得到：MySQL 8.0 服务、utf8mb4 字符集、一个业务库 `app_db`、一个可远程连接的业务账号 `app`、开机自启、幂等可重复执行。

## 二、环境准备

1. 控制节点已按第 2 篇装好 Ansible（`pipx install ansible`，含 community 集合）；
2. 受管节点 node1 可 SSH 免密、有免密 sudo；
3. inventory（`~/ansible-demo/inventory.ini`）：

```ini
[mysql]
node1 ansible_host=192.168.100.11 ansible_user=deploy
```

4. 敏感密码用 Vault（第 4 篇第五节），本篇为降低门槛先写在变量里，**上生产前务必改成 `vault_` 变量**。

项目目录：

```text
~/ansible-demo/
├── ansible.cfg
├── inventory.ini
├── vars/
│   └── mysql.yml            # 变量文件
└── mysql-standalone.yml     # 本篇主角
```

## 三、变量文件

`vars/mysql.yml`：

```yaml
# --- 安装 ---
mysql_packages:
  - mysql-server
  - mysql-client
  - python3-pymysql        # community.mysql 模块在目标机上的 Python 依赖,必装

# --- 配置 ---
mysql_bind_address: "0.0.0.0"          # 对内网开放(默认 127.0.0.1 只允许本机)
mysql_max_connections: 500
mysql_charset: utf8mb4

# --- 初始化内容 ---
mysql_databases:
  - name: app_db
    encoding: utf8mb4
    collation: utf8mb4_unicode_ci

mysql_users:
  - name: app
    host: "192.168.100.%"              # 只允许同网段机器连接,别裸用 %
    password: "App#2026Pwd"            # 生产:改为 {{ vault_mysql_app_pwd }}
    priv: "app_db.*:ALL"               # 只授权业务库,不碰全局
```

## 四、Playbook 全文（逐段讲解在后）

`mysql-standalone.yml`：

```yaml
---
- name: 部署 MySQL 8 单机
  hosts: mysql
  become: true
  vars_files:
    - vars/mysql.yml

  tasks:
    # ---------- 1. 安装 ----------
    - name: 安装 MySQL 服务端与 PyMySQL 依赖
      ansible.builtin.apt:
        name: "{{ mysql_packages }}"
        state: present
        update_cache: true
        cache_valid_time: 3600

    # ---------- 2. 自定义配置 ----------
    - name: 下发 Ansible 自定义配置(独立文件,不动官方 mysqld.cnf)
      ansible.builtin.copy:
        dest: /etc/mysql/mysql.conf.d/99-ansible.cnf
        content: |
          [mysqld]
          bind-address        = {{ mysql_bind_address }}
          max_connections     = {{ mysql_max_connections }}
          character-set-server = {{ mysql_charset }}
          collation-server    = utf8mb4_unicode_ci
        owner: root
        group: root
        mode: "0644"
      notify: 重启 MySQL                # 配置有变化才重启 → 幂等

    # ---------- 3. 服务状态 ----------
    - name: 确保 MySQL 运行且开机自启
      ansible.builtin.service:
        name: mysql
        state: started
        enabled: true

    - name: 等待 3306 端口就绪
      ansible.builtin.wait_for:
        port: 3306
        timeout: 120

    # ---------- 4. 建库(走本地 unix socket 认证) ----------
    - name: 创建业务数据库
      community.mysql.mysql_db:
        name: "{{ item.name }}"
        encoding: "{{ item.encoding }}"
        collation: "{{ item.collation }}"
        state: present
        login_unix_socket: /var/run/mysqld/mysqld.sock
      loop: "{{ mysql_databases }}"
      loop_control:
        label: "{{ item.name }}"

    # ---------- 5. 建用户并授权 ----------
    - name: 创建业务账号
      community.mysql.mysql_user:
        name: "{{ item.name }}"
        host: "{{ item.host }}"
        password: "{{ item.password }}"
        priv: "{{ item.priv }}"
        state: present
        login_unix_socket: /var/run/mysqld/mysqld.sock
      loop: "{{ mysql_users }}"
      loop_control:
        label: "{{ item.name }}"
      no_log: true                      # 含密码的任务,日志不落明文!

    # ---------- 6. 验证 ----------
    - name: 验证版本与库
      community.mysql.mysql_info:
        login_unix_socket: /var/run/mysqld/mysqld.sock
        filter:
          - version
      register: info
      changed_when: false               # 查询不算变更

    - name: 打印 MySQL 版本
      ansible.builtin.debug:
        msg: "MySQL 版本: {{ info.version.major }}.{{ info.version.minor }} ({{ info.version.full }})"
```

```yaml
  handlers:
    - name: 重启 MySQL
      ansible.builtin.service:
        name: mysql
        state: restarted
```

> **`no_log: true` 要点**：任何含密码的任务都加它，Ansible 会连输出一起隐藏，防止密码进日志。加 `no_log` 后排错时可临时去掉或改用 debug 打非敏感字段。

## 五、逐段讲解

**① 安装**：`mysql-server` 装服务端，`python3-pymysql` 是 community.mysql 模块与 MySQL 通信的 Python 驱动——**漏装它，第 4、5 步必然报错 `ModuleNotFoundError: pymysql`**。

**② 配置用"独立文件"**：不直接改官方 `mysqld.cnf`（升级易冲突、难对比），而是放一个 `99-ansible.cnf`——MySQL 按**文件名顺序**加载配置，`99-` 保证我们的值排在最后生效。整段 `content:` 直接写在任务里，也可改为 `template` 引用 j2 模板（第 4 篇）。

**③ `notify: 重启 MySQL`**：首次部署与改配置时会重启一次；之后重复执行配置无变化 → `ok` → 不重启。这就是幂等的价值。

**④/⑤ 建库建用户**：`login_unix_socket` 走 Ubuntu 的 root 默认通道（`auth_socket`），**不需要知道 root 密码**就能完成初始化——这是 Ubuntu MySQL 下 Ansible 管理的标准姿势。用户 `host: "192.168.100.%"` 限定了连接来源网段。

**⑥ 验证**：`mysql_info` 取版本并打印；`changed_when: false` 声明这是查询任务，避免假 changed。

## 六、执行与验证

```bash
cd ~/ansible-demo

# 1) 彩排:看会改什么,不真改
ansible-playbook mysql-standalone.yml --check --diff

# 2) 正式执行
ansible-playbook mysql-standalone.yml
# 期望 PLAY RECAP: node1 ok=8 changed=4 failed=0

# 3) 再跑一遍验证幂等:应几乎全部 ok,changed=0
ansible-playbook mysql-standalone.yml
```

从**另一台内网机器**（不是本机）验证远程可达：

```bash
mysql -h 192.168.100.11 -P 3306 -u app -p'App#2026Pwd' app_db -e "SELECT version(), @@hostname;"
```

服务端上的手工检查命令（备查）：

```bash
systemctl status mysql
mysql -e "SHOW DATABASES; SELECT user,host FROM mysql.user WHERE user='app';"   # root 走 socket
```

## 七、常见问题（FAQ）

| 现象 | 原因与处理 |
| --- | --- |
| `ModuleNotFoundError: pymysql` | 目标机没装 `python3-pymysql`（或装到了别的 Python 解释器） |
| `Please explicitly state intended protocol` | community.mysql 连接歧义：任务里补上 `login_unix_socket` 参数 |
| 远程连接报 `Host ... is not allowed to connect` | 用户 `host` 网段没覆盖来源 IP；检查 `SELECT user,host FROM mysql.user;` |
| 远程连接超时 | `bind-address` 仍是 127.0.0.1（本篇配置没生效？看 99-ansible.cnf 是否下发成功）；或云主机安全组/ufw 未放行 3306 |
| 重启失败 `unknown variable lower_case_table_names` | 8.0 只允许在**初始化前**设置该参数；已有实例想改只能重建数据目录（别在配置里加它） |
| 中文乱码 | 确认库/连接都是 utf8mb4：`SHOW VARIABLES LIKE 'character%';` |
| 密码改了但 playbook 重跑不生效 | `mysql_user` 的 `password` 变更即更新；若加了 `no_log` 看不到结果，先去掉验证 |

## 八、小结与扩展

- Ubuntu 下管理 MySQL 的标准姿势：`apt` 装包 + `python3-pymysql` + `login_unix_socket` 认证；
- 配置用独立编号文件（`99-ansible.cnf`）+ handler 重启，幂等且不污染官方配置；
- 建库建用户全部数据化（`mysql_databases`/`mysql_users` 列表变量），新增库=改一行变量；
- 上生产的两步升级：密码进 Vault；把本 playbook 抽成 role（第 4 篇）供多项目复用。

下一篇升级成经典架构：一主一从 + GTID 复制 + 只读从库，实现读写分离的基础设施。

---

*导航：[README](README.md) · 上一篇：[04-Roles与工程化](04-Roles与工程化.md) · 下一篇：[06-实操案例-MySQL主从读写分离](06-实操案例-MySQL主从读写分离.md)*
