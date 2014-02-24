$script = <<SCRIPT
#!/usr/bin/env bash

if ! which tmux vim zsh git jq &>/dev/null
then
  if which yum &>/dev/null
  then
    yum install -y tmux vim zsh git jq
  elif which apt-get &>/dev/null
  then
    apt-get -y install tmux vim zsh git-core jq
  fi
fi

# backup bashrc
su -c "test -f /home/vagrant/.bashrc -a ! -f /home/vagrant.bashrc.bak && mv /home/vagrant/.bashrc{,.bak}" vagrant
# link in my config files
su -c "cd /home/vagrant/conf && ./init.sh" vagrant
SCRIPT

Vagrant.configure("2") do |config|
  config.vm.synced_folder File.expand_path("~/conf"), "/home/vagrant/conf"
  config.vm.provision "shell", inline: $script
end

# vim: ft=ruby sts=2 sw=2
