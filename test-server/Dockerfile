# Disposable SSH target for exercising Smartcom Revisited end to end.
# Not for production use — it deliberately allows password login.
FROM ubuntu:24.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server iproute2 iputils-ping net-tools \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd

# Test account: testuser / testpass
RUN useradd -m -s /bin/bash testuser \
 && echo 'testuser:testpass' | chpasswd \
 && mkdir -p /home/testuser/.ssh \
 && chown -R testuser:testuser /home/testuser/.ssh \
 && chmod 700 /home/testuser/.ssh

# Password auth on so you can test the password path and key installation,
# which needs an authenticated session before the key exists.
RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config

# A recognisable prompt makes "wait for prompt" blocks easy to target.
RUN echo 'export PS1="testuser@smartcom-test:\w\$ "' >> /home/testuser/.bashrc

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
