# 第 7 篇 · 实操案例：ZooKeeper 三节点集群

> **目标**：三台 Ubuntu 机器一键部署 **ZooKeeper 3.9 集群**（含 Java 环境、myid、zoo.cfg、systemd 服务、健康检查）。本案例第一次用到"模板 + 组内互发现"，是所有"N 节点集群类"中间件（Kafka、Consul、etcd……）的通用套路。

---

## 一、ZooKeeper 是什么、为什么 3 台

ZooKeeper（ZK）是分布式系统的**协调服务**：配置中心、分布式锁、选主、服务注册……Kafka、Hadoop 等都依赖它。它自带共识协议（ZAB），集群里有 **Leader**（处理写）和 **Follower**（处理读+投票）。

**节点数为什么是 3（或 5）？** ZK 要求**过半数（quorum）存活**才能工作：3 台容忍 1 台故障（2/3 在），5 台容忍 2 台。偶数没有意义（4 台也只容忍 1 台），所以生产标准是 3 或 5。

| 端口 | 用途 |
| --- | --- |
| **2181** | 客户端连接端口 |
| **2888** | Follower → Leader 数据同步 |
| **3888** | 选主投票 |
| 8080 | ZK 自带 admin server（本篇关掉，避免与常见 Web 服务撞端口） |

集群形态要点：**每台机器必须有唯一 `myid`（整数）**，且 `zoo.cfg` 里要列出所有节点的 `server.N=IP:2888:3888`——`N` 就是 myid。这正是模板+变量能自动化的部分。

## 二、环境准备

inventory：

```ini
[zk]
zk1 ansible_host=192.168.100.11 ansible_user=deploy
zk2 ansible_host=192.168.100.12 ansible_user=deploy
zk3 ansible_host=192.168.100.13 ansible_user=deploy
```

> 注意：三台机器的主机名别与 MySQL 案例冲突——inventory 别名（zk1/zk2/zk3）是 Ansible 视角的名字，与系统主机名无关。

目录结构：

```text
~/ansible-demo/
├── inventory.ini
├── vars/zk.yml
├── templates/
│   ├── zoo.cfg.j2
│   └── zookeeper.service.j2
└── zookeeper-cluster.yml
```

变量文件 `vars/zk.yml`：

```yaml
zk_version: "3.9.7"                       # 写作时点的当前版本,可换成更新小版本
zk_download_url: "https://dlcdn.apache.org/zookeeper/zookeeper-{{ zk_version }}/apache-zookeeper-{{ zk_version }}-bin.tar.gz"
zk_install_dir: /opt/zookeeper            # 软链目标,实际解压到 /opt/apache-zookeeper-x.y.z-bin
zk_data_dir: /data/zookeeper/data         # myid 与快照
zk_log_dir: /data/zookeeper/logs
zk_user: zookeeper                        # 专用低权限运行用户
zk_client_port: 2181
zk_java_home: /usr/lib/jvm/java-17-openjdk-amd64
```

> 下载地址注意：`dlcdn.apache.org` 只保留**最新版本**；若 404（版本已更新），改用归档站 `https://archive.apache.org/dist/zookeeper/zookeeper-3.9.7/apache-zookeeper-3.9.7-bin.tar.gz`。内网机器可先把 tar 包放到一个内网 HTTP 服务上，改 URL 即可。

## 三、模板

`templates/zoo.cfg.j2`（核心：用 `groups['zk']` 自动生成全部成员）：

```ini
tickTime=2000
initLimit=10
syncLimit=5
dataDir={{ zk_data_dir }}
dataLogDir={{ zk_log_dir }}
clientPort={{ zk_client_port }}
autopurge.snapRetainCount=3
autopurge.purgeInterval=1
# 关闭自带 admin server(8080),避免端口冲突
admin.enableServer=false
# 放开健康检查用的四字命令
4lw.commands.whitelist=srvr,ruok,mntr,conf

# 集群成员清单 —— Ansible 自动生成,无需手改
{% for host in groups['zk'] %}
server.{{ loop.index }}={{ hostvars[host]['ansible_host'] }}:2888:3888
{% endfor %}
```

`templates/zookeeper.service.j2`（tar 包不带 systemd 单元，我们自己造）：

```ini
[Unit]
Description=Apache ZooKeeper
After=network.target

[Service]
Type=simple
User={{ zk_user }}
Environment="JAVA_HOME={{ zk_java_home }}"
ExecStart={{ zk_install_dir }}/bin/zkServer.sh start-foreground
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

> `start-foreground` 让 ZK 在前台运行，交给 systemd 托管（崩溃自动拉起、日志进 journald），比传统 `zkServer.sh start` 的后台自管模式更可靠。

## 四、Playbook 全文

`zookeeper-cluster.yml`：

```yaml
---
- name: 部署 ZooKeeper 三节点集群
  hosts: zk
  become: true
  vars_files: [vars/zk.yml]

  tasks:
    # ---------- 1. 基础环境 ----------
    - name: 安装 Java 17 与工具
      ansible.builtin.apt:
        name: [openjdk-17-jdk-headless, netcat-openbsd]
        state: present
        update_cache: true

    - name: 创建运行用户
      ansible.builtin.user:
        name: "{{ zk_user }}"
        system: true
        shell: /usr/sbin/nologin
        home: "{{ zk_data_dir }}"

    - name: 创建数据与日志目录
      ansible.builtin.file:
        path: "{{ item }}"
        state: directory
        owner: "{{ zk_user }}"
        group: "{{ zk_user }}"
        mode: "0755"
      loop:
        - "{{ zk_data_dir }}"
        - "{{ zk_log_dir }}"

    # ---------- 2. 下载解压(带缓存:文件已存在则跳过下载) ----------
    - name: 检查安装包是否已存在
      ansible.builtin.stat:
        path: "/tmp/apache-zookeeper-{{ zk_version }}-bin.tar.gz"
      register: pkg

    - name: 下载安装包
      ansible.builtin.get_url:
        url: "{{ zk_download_url }}"
        dest: "/tmp/apache-zookeeper-{{ zk_version }}-bin.tar.gz"
        mode: "0644"
        timeout: 300
      when: not pkg.stat.exists

    - name: 解压到 /opt
      ansible.builtin.unarchive:
        src: "/tmp/apache-zookeeper-{{ zk_version }}-bin.tar.gz"
        dest: /opt
        owner: "{{ zk_user }}"
        group: "{{ zk_user }}"
        remote_src: true                  # 包已在目标机上,无需从控制节点传

    - name: 建立版本无关的软链 /opt/zookeeper
      ansible.builtin.file:
        src: "/opt/apache-zookeeper-{{ zk_version }}-bin"
        dest: "{{ zk_install_dir }}"
        state: link
        owner: "{{ zk_user }}"
        group: "{{ zk_user }}"
        force: true

    # ---------- 3. 集群配置 ----------
    - name: 写入 myid(节点在 zk 组中的序号+1)
      ansible.builtin.copy:
        content: "{{ groups['zk'].index(inventory_hostname) + 1 }}"
        dest: "{{ zk_data_dir }}/myid"
        owner: "{{ zk_user }}"
        group: "{{ zk_user }}"
        mode: "0644"
      notify: 重启 ZooKeeper

    - name: 下发 zoo.cfg
      ansible.builtin.template:
        src: templates/zoo.cfg.j2
        dest: "{{ zk_install_dir }}/conf/zoo.cfg"
        owner: "{{ zk_user }}"
        group: "{{ zk_user }}"
        mode: "0644"
      notify: 重启 ZooKeeper

    - name: 下发 systemd 服务单元
      ansible.builtin.template:
        src: templates/zookeeper.service.j2
        dest: /etc/systemd/system/zookeeper.service
        mode: "0644"
      notify:
        - 重载 systemd
        - 重启 ZooKeeper

    # ---------- 4. 启动 ----------
    - name: 启动并设置开机自启
      ansible.builtin.systemd:
        name: zookeeper
        state: started
        enabled: true
        daemon_reload: true

    - name: 等待 2181 端口就绪
      ansible.builtin.wait_for:
        port: "{{ zk_client_port }}"
        timeout: 120

    # ---------- 5. 健康检查 ----------
    - name: 查询本机角色(srvr 四字命令)
      ansible.builtin.command: "echo srvr | nc 127.0.0.1 {{ zk_client_port }}"
      register: srvr
      changed_when: false

    - name: 打印角色信息
      ansible.builtin.debug:
        msg: "{{ inventory_hostname }} → {{ srvr.stdout_lines | select('match','Mode') | first }}"
        # 输出形如 "Mode: leader" 或 "Mode: follower"

  handlers:
    - name: 重载 systemd
      ansible.builtin.systemd:
        daemon_reload: true

    - name: 重启 ZooKeeper
      ansible.builtin.systemd:
        name: zookeeper
        state: restarted
```

## 五、执行与验证

```bash
cd ~/ansible-demo
ansible-playbook zookeeper-cluster.yml
# 期望:三台机器全绿;健康检查分别打印 Mode: leader / follower / follower
```

**验证 1：集群角色与互通**：

```bash
for h in 192.168.100.11 192.168.100.12 192.168.100.13; do
  ssh deploy@$h "echo srvr | nc 127.0.0.1 2181 | grep -E 'Mode|Zookeeper version'"
done
# 期望:一台 leader,两台 follower,版本 3.9.7
```

**验证 2：写入广播**——在一台机器上建 znode，任何一台都能读到：

```bash
ssh deploy@192.168.100.11 "/opt/zookeeper/bin/zkCli.sh -server 127.0.0.1:2181 create /ansible-test hello"
ssh deploy@192.168.100.12 "/opt/zookeeper/bin/zkCli.sh -server 127.0.0.1:2181 get /ansible-test"
# 期望输出: hello
```

**验证 3：容错**——停掉 leader 后集群应自动选出新 leader：

```bash
ssh deploy@192.168.100.11 "sudo systemctl stop zookeeper"
# 到另外两台上再跑 srvr,会看到新的 leader;重启 node1 后它以 follower 身份回归
```

## 六、常见问题（FAQ）

| 现象 | 原因与处理 |
| --- | --- |
| 启动报 `myid file is missing` / `Invalid config ... server.N` | myid 数字与 zoo.cfg 的 `server.N` 对不上；确认 `groups['zk'].index(inventory_hostname)+1` 生成的 myid 与机器对应 |
| 日志报 `Cannot open channel to X` 反复重试 | 集群成员互相不可达：2888/3888 端口被防火墙拦（`ufw allow 2888/tcp; ufw allow 3888/tcp`），或 inventory 里 IP 写错 |
| systemd 启动失败 `JAVA_HOME is not set` | 模板里 `Environment="JAVA_HOME=..."` 没生效或路径不对；`ls /usr/lib/jvm/` 确认实际路径 |
| 下载 404 | dlcdn 只留最新版；改用 `archive.apache.org` 归档地址（见第二节注） |
| 客户端连不上 2181 | 服务未起（先看 `journalctl -u zookeeper`）；或安全组没放行；或被 4lw 白名单误伤（本篇已放开 srvr/mntr） |
| `ruok` 返回空 | 四字命令没加白名单：`4lw.commands.whitelist` 里补上 |
| 集群整体不服务 | **存活节点不过半**——ZK 的设计如此（3 台挂 2 台就停），不是故障；这是 CAP 中的一致性优先 |
| 时钟/时延问题导致选举抖动 | 节点间开 NTP 同步；跨机房部署时检查 RTT（建议 < 100ms） |

## 七、小结与迁移指南

- 三节点集群的通用套路：**专用用户 → 目录 → 下载解压（缓存判断） → myid + 模板配置（组内互发现） → systemd 托管前台进程 → wait_for + 健康检查**；
- `groups['zk']` + `hostvars` 让"成员清单"全自动，加一台机器=inventory 加一行重跑；
- `stat + when` 的"包已存在则跳过下载"是外网机器部署的省时间套路；
- systemd 管理 `start-foreground`，进程崩溃自动拉起，日志 `journalctl -u zookeeper` 可查；
- 3 台容忍 1 台故障；生产建议 5 台 + 每台机器独立故障域（不同宿主机/机架）。

下一篇是系列最重的一篇：Elasticsearch 三节点集群。

---

*导航：[README](README.md) · 上一篇：[06-实操案例-MySQL主从读写分离](06-实操案例-MySQL主从读写分离.md) · 下一篇：[08-实操案例-Elasticsearch三节点集群](08-实操案例-Elasticsearch三节点集群.md)*
